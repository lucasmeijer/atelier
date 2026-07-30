# Tabs and layouts now feel immediate

Creating, closing, moving, and rearranging tabs no longer rebuilds every live pane. Atelier now moves the existing panes into the server-rendered layout, preserving terminal sessions, browser frames, scroll positions, and unsaved editor state while avoiding repeated workspace attachment work.

The Files tab loads its directory only when opened, layout persistence no longer fetches workspace contents, and browser assets plus server-rendered responses are now minified or compressed. Together these changes make opening Atelier, creating tabs, and changing group layouts substantially faster—especially over a remote connection.
