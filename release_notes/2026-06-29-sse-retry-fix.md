# Update progress stability

This test release verifies that closing or reconnecting the update progress stream no longer interrupts Atelier while an update is being pulled.

- Clicking Update Atelier should not disconnect active terminal tabs.
- The sidebar should move from pull progress to Restart to update.
- Retrying should attach to the same update flow instead of leaving the sidebar stuck.
