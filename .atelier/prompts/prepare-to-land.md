---
Description: Simplify and review the current work before landing
quick-launch: true
hotkey: o
---

Review your complete body of work, and try to simplify it. remove code that is now dead. simplify code that can now be simpler. reuse code that makes sense to be shared. find leftovers from previous attempts

When you are done with that, start a subagent with no context, and ask it this

-------
Review your body of work (if unclear what that is, consider it to be the git diff).
Review it for correctness,  for missed opportunities to do something simpler.

I always want to be informed if the pr adds new state that gets serialized to disk.
I always want to be informed if the pr will cause issues when users upgrade old atelier installs to a version that has this pr in it.
-------

When you get its results, do not blindly accept them. Fix the issues that you feel should be fixed. For the ones where you feel the review agent doesn't have a strong case, or where it suggests something that went against my original instructions, do not fix it.

If the fixes were not super-low-risk, do another round with a new review agent. Never do more than 2 rounds.

Your final report to me will be have:
- call out if it adds serialized state
- call out if there's an upgrade concern
- for each review agent item that you decided not to act on, a short explanation why.

