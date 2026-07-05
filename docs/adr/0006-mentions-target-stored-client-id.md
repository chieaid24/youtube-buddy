# @mentions target a stored Client ID, not matched display-name text

The Room Feed must show a member when they are @mentioned in a Note or Reply. The question is how a Mention identifies its target. Per CONTEXT.md, identity is the **Client ID** (stable per browser install); the **Display Name** is non-unique and purely cosmetic — two members can share a name, and a member may have a blank name. Two options:

- **(a) Plain-text match** — a Note "mentions you" if its body contains `@<your Display Name>`. No schema change.
- **(b) Resolve at author time** — the author picks a member from a roster; the Note/Reply stores that member's Client ID in a `mentions` list. The Feed matches on Client ID.

We chose **(b)**.

Text matching is ambiguous and brittle: two members named "bob" both light up on `@bob`; a mention silently breaks the moment either party renames; and a blank-name member cannot be mentioned at all. Storing the Client ID makes a Mention mean exactly one person, survives renames, and works for blank-name members. The authoring experience stays natural — type `@`, fuzzy-search a roster of current Room members shown below the field, pick one — so the inline text can still render `@Bob` while the durable target is the opaque Client ID. The roster is the Room's current membership, already derivable on the client (the union of presence / progress / note / reply / event Client IDs) together with each member's latest Display Name.

## Consequences

- The Note and Reply contracts gain an **optional** `mentions` field (an array of Client IDs). The backend validates it (array of strings, bounded length), stores it, and returns it in the Room read and in the complete-record POST responses. Absent means no mentions, so the change is backward compatible with existing stored records and older clients.
- The composer and the Reply input gain an `@`-autocomplete popover with fuzzy roster search — the first place the extension needs the live roster at compose time (the popup already computes a similar roster for its swatch list).
- The Feed's "@mentioned you" check is a Client-ID membership test over `notes[]` / `replies[]`, computed on the client; there is no per-recipient storage (consistent with the no-inbox Room Feed decision).
- Client IDs are stable across rejoins, so a Mention keeps resolving to the same person if they leave and come back. A Mention of a member who is permanently gone simply never matches anyone present; the stored Client ID is inert and harmless.
- Rendering `@Bob` means resolving a stored Client ID back to a current Display Name at render time. If that member is no longer in the roster, fall back to the stable "<Adjective> Buddy" name (`YTB.buddyName`), never to a raw Client ID.
