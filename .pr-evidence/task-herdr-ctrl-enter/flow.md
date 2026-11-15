```mermaid
flowchart LR
  A[Before: quick keys Esc Tab 1 2 3] -->|no Ctrl+Enter on touch| X[Ctrl+Enter unreachable]
  B[After: quick keys Esc Tab 1 2 3 Ctrl+⏎] -->|tap| C["onInput(ESC [ 13 ; 5 u)"] --> D[active terminal]
```
