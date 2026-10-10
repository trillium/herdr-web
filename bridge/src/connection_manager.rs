use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConnection {
    pub client_id: String,
    pub nickname: String,
    pub priority: i32,
    pub connected_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConnections {
    pub connections: Vec<TerminalConnection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionPreferences {
    pub priorities: HashMap<String, HashMap<String, i32>>, // terminal_id -> client_id -> priority
    pub nicknames: HashMap<String, String>,                // client_id -> nickname
}

pub struct ConnectionManager {
    active_connections: Arc<Mutex<HashMap<String, Vec<TerminalConnection>>>>,
    preferences: Arc<Mutex<ConnectionPreferences>>,
    preferences_path: std::path::PathBuf,
    /// One-shot kick signal per live client; the value is "also clear the
    /// device's saved pane state". Removed when the client leaves or is kicked.
    kick_signals: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
}

impl ConnectionManager {
    pub fn new(preferences_path: std::path::PathBuf) -> Self {
        let preferences = Self::load_preferences(&preferences_path);
        Self {
            active_connections: Arc::new(Mutex::new(HashMap::new())),
            preferences: Arc::new(Mutex::new(preferences)),
            preferences_path,
            kick_signals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Arms a kick signal for a live client. The socket loop owns the receiver
    /// and closes the connection when it fires; the client may simply reconnect.
    pub fn register_kick(&self, client_id: &str) -> tokio::sync::oneshot::Receiver<bool> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut signals) = self.kick_signals.lock() {
            signals.insert(client_id.to_string(), tx);
        }
        rx
    }

    /// Force-disconnects a client. Returns false when it is not connected.
    pub fn kick(&self, client_id: &str, clear_state: bool) -> Result<bool, String> {
        let sender = self
            .kick_signals
            .lock()
            .map_err(|e| e.to_string())?
            .remove(client_id);
        Ok(sender.is_some_and(|tx| tx.send(clear_state).is_ok()))
    }

    pub fn register_connection(
        &self,
        terminal_id: &str,
        client_id: &str,
        nickname: String,
    ) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();

        let mut connections = self.active_connections.lock().map_err(|e| e.to_string())?;
        let terminal_conns = connections
            .entry(terminal_id.to_string())
            .or_insert_with(Vec::new);

        // Check if client already connected
        if terminal_conns.iter().any(|c| c.client_id == client_id) {
            return Err(format!(
                "Client {} already connected to {}",
                client_id, terminal_id
            ));
        }

        // Get priority from preferences or default
        let priority = self
            .preferences
            .lock()
            .map_err(|e| e.to_string())?
            .priorities
            .get(terminal_id)
            .and_then(|p| p.get(client_id))
            .copied()
            .unwrap_or_else(|| Self::default_priority(&nickname));

        terminal_conns.push(TerminalConnection {
            client_id: client_id.to_string(),
            nickname: nickname.clone(),
            priority,
            connected_at: now,
        });

        // Update nickname in preferences
        let mut prefs = self.preferences.lock().map_err(|e| e.to_string())?;
        prefs.nicknames.insert(client_id.to_string(), nickname);
        drop(prefs);

        self.save_preferences()?;
        Ok(())
    }

    pub fn unregister_connection(&self, terminal_id: &str, client_id: &str) -> Result<(), String> {
        if let Ok(mut signals) = self.kick_signals.lock() {
            signals.remove(client_id);
        }
        let mut connections = self.active_connections.lock().map_err(|e| e.to_string())?;
        if let Some(conns) = connections.get_mut(terminal_id) {
            conns.retain(|c| c.client_id != client_id);
            if conns.is_empty() {
                connections.remove(terminal_id);
            }
        }
        Ok(())
    }

    pub fn get_connections(&self, terminal_id: &str) -> Result<Vec<TerminalConnection>, String> {
        let connections = self
            .active_connections
            .lock()
            .map_err(|e| e.to_string())?
            .get(terminal_id)
            .cloned()
            .unwrap_or_default();
        Ok(connections)
    }

    pub fn get_all_connections(&self) -> Result<HashMap<String, Vec<TerminalConnection>>, String> {
        Ok(self
            .active_connections
            .lock()
            .map_err(|e| e.to_string())?
            .clone())
    }

    pub fn get_highest_priority_client(&self, terminal_id: &str) -> Result<Option<String>, String> {
        let connections = self.get_connections(terminal_id)?;
        if connections.is_empty() {
            return Ok(None);
        }
        Ok(connections
            .into_iter()
            .max_by_key(|c| c.priority)
            .map(|c| c.client_id))
    }

    pub fn set_priority(
        &self,
        terminal_id: &str,
        client_id: &str,
        priority: i32,
    ) -> Result<(), String> {
        // Update in active connections
        let mut connections = self.active_connections.lock().map_err(|e| e.to_string())?;
        if let Some(conns) = connections.get_mut(terminal_id) {
            if let Some(conn) = conns.iter_mut().find(|c| c.client_id == client_id) {
                conn.priority = priority;
            }
        }
        drop(connections);

        // Update in preferences
        let mut prefs = self.preferences.lock().map_err(|e| e.to_string())?;
        prefs
            .priorities
            .entry(terminal_id.to_string())
            .or_insert_with(HashMap::new)
            .insert(client_id.to_string(), priority);
        drop(prefs);

        self.save_preferences()?;
        Ok(())
    }

    pub fn set_nickname(&self, client_id: &str, nickname: String) -> Result<(), String> {
        let mut prefs = self.preferences.lock().map_err(|e| e.to_string())?;
        prefs.nicknames.insert(client_id.to_string(), nickname);
        drop(prefs);
        self.save_preferences()?;
        Ok(())
    }

    fn default_priority(nickname: &str) -> i32 {
        match nickname {
            n if n.contains("web") => 10,
            n if n.contains("mirror") => 0,
            n if n.contains("observe") => 0,
            _ => 5,
        }
    }

    fn load_preferences(path: &Path) -> ConnectionPreferences {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(prefs) = serde_json::from_str(&contents) {
                return prefs;
            }
        }
        ConnectionPreferences {
            priorities: HashMap::new(),
            nicknames: HashMap::new(),
        }
    }

    fn save_preferences(&self) -> Result<(), String> {
        let prefs = self.preferences.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*prefs).map_err(|e| e.to_string())?;
        fs::write(&self.preferences_path, json).map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Clone for ConnectionManager {
    fn clone(&self) -> Self {
        Self {
            active_connections: Arc::clone(&self.active_connections),
            preferences: Arc::clone(&self.preferences),
            preferences_path: self.preferences_path.clone(),
            kick_signals: Arc::clone(&self.kick_signals),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> ConnectionManager {
        ConnectionManager::new(std::env::temp_dir().join(format!(
            "herdr-web-kick-test-{}.json",
            std::process::id()
        )))
    }

    #[test]
    fn kick_fires_the_armed_signal_once_and_carries_clear_state() {
        let manager = manager();
        let mut rx = manager.register_kick("c1");
        assert_eq!(manager.kick("c1", true), Ok(true));
        assert_eq!(rx.try_recv(), Ok(true));
        assert_eq!(manager.kick("c1", true), Ok(false));
    }

    #[test]
    fn kick_of_an_unknown_or_departed_client_reports_not_connected() {
        let manager = manager();
        assert_eq!(manager.kick("nobody", false), Ok(false));
        let _rx = manager.register_kick("c2");
        manager.unregister_connection("t", "c2").unwrap();
        assert_eq!(manager.kick("c2", false), Ok(false));
    }
}
