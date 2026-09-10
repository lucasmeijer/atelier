package main

import (
	"context"
	"fmt"

	"github.com/containerd/errdefs"
)

// Called under Store's lock. A client's creator is immutable: an idempotent
// registration must not reparent an existing workspace or revive a retired one.
func (s *Store) claimClient(id, parent string) error {
	if s.state.Retired[id] {
		return errdefs.ErrFailedPrecondition
	}
	if parent != "" {
		if !clientPattern.MatchString(parent) || parent == id {
			return errdefs.ErrInvalidArgument
		}
		if s.state.Clients[parent] == nil || s.state.Retired[parent] {
			return fmt.Errorf("creator %q is not registered and active: %w", parent, errdefs.ErrFailedPrecondition)
		}
	}
	if s.state.Clients[id] != nil {
		if s.state.Parents[id] != parent {
			return fmt.Errorf("client %q already has another creator: %w", id, errdefs.ErrFailedPrecondition)
		}
	} else {
		s.state.Clients[id] = map[string]Alias{}
	}
	// Parentage is optional in persisted root-only stores and older intents.
	// Record even a root creator on registration so subsequent transactions
	// preserve an explicit ownership entry without converting snapshot backing.
	if s.state.Parents == nil {
		s.state.Parents = map[string]string{}
	}
	s.state.Parents[id] = parent
	return nil
}

// The administrative service lock excludes registration for this whole
// operation. Tombstone the entire subtree atomically before removing anything:
// a crash must not restore descendant listeners whose owning volume is gone.
// Snapshot restore and content retirement already finish every tombstoned ID.
func (s *Store) retireTree(ctx context.Context, id string) ([]string, error) {
	s.Lock()
	var ids []string
	var visit func(string)
	visit = func(parent string) {
		for child, owner := range s.state.Parents {
			if owner == parent {
				visit(child)
			}
		}
		ids = append(ids, parent)
	}
	visit(id)
	for _, client := range ids {
		s.state.Retired[client] = true
	}
	s.save()
	s.Unlock()
	for _, client := range ids {
		if err := s.retire(ctx, client); err != nil {
			return ids, err
		}
	}
	return ids, nil
}
