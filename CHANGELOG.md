# Changelog

## 1.20.0

- **WYSIWYG image insert & edit.** New image button in the visual editor's toolbar opens a dialog with: image source via Foundry's file picker or a pasted URL/path, alt text, optional caption, a width slider (10–100 % of text width), and a floating mode — *Float left / Float right* wraps body text around the image, *no float* keeps it on its own row. Images are inserted as a `<figure class="almanach-img">` with inline float/margin styles, so the same wrapping renders inside the preview's bare srcdoc iframe (no module CSS in there). Double-click any image while editing to reopen the dialog and change source/size/float/caption or remove it. The caret position is remembered, so inserts land exactly where you were typing.
- **Document lock.** New Lock button in the header (keyhole icon, next to Save). Stores a `locked` flag on the journal entry. While locked, every mutating path is refused for non-owners: editors and mode switching, Save, page create/delete, tab context menu and enable/disable checkboxes, .html upload, Scene Workbench autosave, and the title input — locked-out users are also dropped back to Preview automatically, and the editor becomes read-only. Only the GM or a document owner can make changes or toggle the lock; everyone else sees a read-only "Locked" badge instead of the button. Flag changes propagate to already-open sheets on other clients.


## 1.19.0

- **Geometry-driven tab folding.** Tabs now fold into the "more tabs" dropdown only when they actually collide with the header control buttons (zoom, fit, mode, share, close) — not on a hardcoded count. The tab strip's horizontal scroll has been replaced by intelligent folding: as the window shrinks, tabs fold from right to left into the dropdown; as it grows, they unfold back. Both the tab overflow and header collapse re-evaluate on every resize via a shared ResizeObserver.

## 1.18.0

- **Image right-click menu.** Right-click any image in the document preview (including images inside uploaded interactive documents like the Scene Workbench) to open a glass menu with:
  - **Open image** — opens the full image in a new browser tab.
  - **Show to all players** (GM only) — pops the image on every player's screen via Foundry's image popout.
  - **Show to players** (GM only) — expands a submenu listing the currently connected players with checkboxes; "Show" pops the image only to the selected players.
  - **Show in viewer** — opens the image in a new fancy viewer window (glassmorphic, draggable).
- **Fancy image viewer window** — a real ApplicationV2 window, which the Cypher Taskbar picks up automatically: its blue hand drag handle appears in the header (drag the image to People/Places/Assets/Secrets) and its minimize button docks the window into the taskbar's window tray. Close via the standard header close. Without the taskbar installed it behaves as a normal draggable window.

## 1.17.0

- **Auto-save for uploaded Scene Workbench documents.** Interactive documents built with the Steelbound Scene Workbench keep their live state in the browser; previously, edits made inside the Almanach preview were lost unless exported and re-uploaded. Almanach now detects the workbench (`#embedded-scene` script tag), and every change you make inside it is spliced back into the page's stored HTML automatically (checked every 2 s). Works for the document and all similar documents — any page holding a workbench gets the same treatment when opened.

## 1.16.2

- **"More tabs" menu now opens directly below the toggle** instead of the header's far right. The panel is positioned from the toggle's screen coordinates (clamped to the viewport); it still lives outside the tab strip so the strip's horizontal scroll can't clip it.

## 1.16.1

- **Fixed "More tabs" not opening.** The fold menu's panel was appended to a container class that doesn't exist in the template, so it was never in the DOM. The toggle and panel now live in the template (same pattern as the header's overflow menu) and the panel anchors under the header's right end.

## 1.16.0

- **Tab color now tints the tab's background and border** (hover and active states included, active keeps a colored glow) instead of only an underline.
- **More than three tabs? The rest fold into a "more tabs" menu** at the right end of the tab strip, same dropdown pattern the header uses on narrow windows. Folded tabs stay fully functional — select, × delete, right-click tab menu, and the done-checkbox all work inside the menu.

## 1.15.0

- **Right-click a page tab to open a tab menu**: rename the tab, pick a tab color (9 presets + custom picker + clear), and toggle an optional done-checkbox on the tab.
- **Tab colors** paint a colored underline on the tab and persist per page in the page's `tabUi` flag.
- **Tab checkbox**: when ticked, the tab is simply greyed out — no other behavior. Checkbox and checked state persist per page and are visible to all users; only editors can tick it.
- Color and checkbox changes apply in place without reloading the preview iframe; the menu closes on outside click or Escape.

## 1.14.2

- **Fixed page tabs not deleting.** The × button was a `data-action` element nested inside the tab's own `data-action` button; it is now a sibling button, so the AppV2 action dispatch resolves `deletePage` reliably. Delete failures now surface an error notification instead of failing silently.
- **Page delete is restricted to the document creator.** The × shows only for the GM or the entry's author (`document.author`) — other users with edit access no longer see it.
