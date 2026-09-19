# Persist Work views and attention separately from personal navigation

Atelier persists typed Work-view identities, ordering, and type-specific resources separately from attention. The workspace registry owns persistent workspace, agent, and view attention. Each browser owns its active destinations, pane and drawer visibility, scroll positions, and preload state.

Every workspace has exactly one active phase: provisioning, running, or deleting. Phase activity determines workspace busy state independently of attention. Running activity aggregates agents only. Provisioning and deletion stop being busy for decisions and failures, which request workspace attention.

Attention is cleared by visibility of that specific destination. Workspace visibility never acknowledges hidden agents or views. Live browser connections report visibility; disconnect removes their visibility contribution. Visible destinations never acquire attention. Repeated attention requests preserve oldest-first ordering.

Selecting a workspace reveals its oldest attention-requesting agent and, on desktop only, oldest attention-requesting view. Ordinary attention events never select destinations. An agent presentation additionally reveals its view on desktop, but not mobile. Workspace rows update and move independently through Turbo; preload state only dims their attention dots.
