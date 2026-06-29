# Pull progress compatibility

This test release verifies that Atelier handles Docker pull output that includes plain text status lines before JSON progress events.

- The first update attempt should not fail on `stable: Pulling from ...`.
- Pull progress may be indeterminate when Docker does not report byte totals.
- The sidebar should end at Restart to update after the image is pulled.
