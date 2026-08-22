# Room Home is the complete in-page hub

The Room Feed and Recommendations need space that Chrome's transient Extension Popup cannot provide. Identity, Room membership, Buddy Colors, and Settings also need one durable management surface. Keeping those controls in the Extension Popup would split the product between two places and require the viewer to leave YouTube's page context to manage an in-page experience.

The Room Home Panel already supplies the correct shell. It is a fixed, left-docked portrait overlay on YouTube Home, outside YouTube's layout flow, with its own scroll and a blocking scrim. The Room Home Toggle is the panel's only YouTube DOM dependency.

## Decision

The Room Home Panel is the complete product hub. It has two mutually exclusive views:

- The normal view stacks the Room Feed above Recommendations.
- The Settings view replaces the normal content and shows four visible sections in one scroll: Profile, Room, On-video, and Appearance. A gear opens Settings and Back restores the normal view.

Profile owns Nickname. Room owns Room state, Room Code, Create or Join, the Buddy roster, Buddy Color Swatches, and Leave Room. On-video owns Share video progress, Notes Visibility, Buddy Progress Visibility, Spoiler Default, and Notification Position. Appearance owns Theme Preference. Stop sharing and Leave Room retain confirmation dialogs, and Escape dismisses a confirmation before it can close the panel.

Waiting and In room viewers open into the normal view. Unpaired and Room full viewers open directly into Settings because neither can use the Feed. Room full receives no forced focus, scroll, or highlight. Closing and reopening the panel resets it to the state-appropriate initial view; Settings visibility is never persisted.

The panel remains ephemeral. The Room Home Toggle opens or closes it. The header close control, a scrim click, Escape, or a single-page navigation closes it. Closing hides the surface and never changes Room membership, Sharing, or Recommendations.

The panel stays outside YouTube's layout flow. It appends to the page body, reads no home-grid layout DOM, and coordinates with the toggle through in-page events. ADR-0001 still applies: the content script owns the in-page experience, and the extension adds no background service worker.

## Consequences

- The Room Home Panel becomes the only surface that changes identity, Room membership, Buddy Colors, or Settings.
- The Extension Popup can shrink to read-only status and navigation without duplicating management behavior.
- The old sidebar Control Panel Launcher and its hidden relay frame are removed. The Room Home Toggle row performs one job again.
- The panel keeps its current portrait geometry and blocking scrim. The Settings view scrolls inside that shell instead of adding accordions or nested pages.
- All moved controls must preserve live storage propagation and the existing Room, Sharing, and Connection Lost semantics.
- Every Settings flow now renders on live YouTube and must pass the repository's live UI verification gate.
