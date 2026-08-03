// The extension specs read only `window.YTB` / `window.YTBRoomCode`, whose shapes
// are declared via `interface Window` augmentation in the spec files. The classic
// content scripts aren't in the program (their `window.X =` expando would shadow
// that interface), so declare the `window` value here instead of pulling in DOM.
declare var window: Window;
