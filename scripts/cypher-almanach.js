/**
 * Cypher Almanach - Modern Glassmorphic Journal Sheet for Foundry VTT (v13 & v14+)
 *
 * Raw HTML is stored in a document FLAG (`page.flags["cypher-almanach"].rawHtml`),
 * bypassing Foundry's automatic HTMLField sanitizer.
 *
 * Rendering uses a same-origin `srcdoc` iframe with fit-width (default)/fit-page
 * modes, manual zoom, and click-and-drag panning of the rendered content. Because
 * the native window-header is hidden (frameless design), dragging the window is
 * re-implemented manually on the custom `.almanach-header` bar.
 */

const MODULE_ID = "cypher-almanach";
const SHEET_CLASS_ID = `${MODULE_ID}.CypherAlmanachSheet`;
const RAW_HTML_FLAG = "rawHtml";
const PLACEHOLDER_TEXT_CONTENT = "<p><em>This page's content is rendered by the Cypher Almanach sheet. Open this Journal Entry with its custom sheet to view/edit the full unsanitized HTML.</em></p>";

const { DocumentSheetV2, HandlebarsApplicationMixin } = foundry.applications.api;

function getPageRawHtml(page) {
  if (!page) return "";
  const flagValue = page.getFlag?.(MODULE_ID, RAW_HTML_FLAG);
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
  return page.text?.content || page.system?.text?.content || "";
}

async function setPageRawHtml(page, rawHtml, extraUpdates = {}) {
  const updates = {
    "text.content": PLACEHOLDER_TEXT_CONTENT,
    [`flags.${MODULE_ID}.${RAW_HTML_FLAG}`]: rawHtml,
    ...extraUpdates
  };
  return page.update(updates);
}

/**
 * Fancy image viewer for the Almanach — a real ApplicationV2 window, which
 * is what makes the Cypher Taskbar integrations work for free:
 *
 * - Minimize: the taskbar's `renderApplicationV2` hook injects its minimize
 *   button into the native `.window-header`, and `_minimizeWindow()` docks
 *   the window into the taskbar's window tray.
 * - Blue hand: `options.src` makes the window hand-eligible, so the taskbar
 *   injects the blue `fa-hand-paper` drag handle ("Drag to add to
 *   People/Places/Assets/Secrets") whose payload is
 *   `{ uuid: null, name: title, img: src, type: "Image" }`.
 *
 * Without the taskbar installed it is still a normal draggable, closable
 * AppV2 window — the extra header buttons simply never appear.
 */
class AlmanachImageViewer extends HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cypher-almanach-image-viewer",
    classes: ["cypher-almanach-image-viewer"],
    window: {
      frame: true,
      positioned: true,
      controls: []
    },
    position: {
      width: 720,
      height: "auto"
    },
    src: null,
    title: "Image",
    actions: {}
  };

  static PARTS = {
    viewer: {
      template: "modules/cypher-almanach/templates/almanach-image-viewer.hbs"
    }
  };

  get title() {
    return this.options.title || "Image";
  }

  async _prepareContext() {
    return {
      src: this.options.src,
      title: this.options.title
    };
  }
}

class CypherAlmanachSheet extends HandlebarsApplicationMixin(DocumentSheetV2) {
  constructor(...args) {
    super(...args);
    this._activePageId = null;
    this._editorMode = "preview"; // "preview" | "wysiwyg" | "code"
    this._showCypherBar = false;
    this._fitMode = "width"; // "width" (default) | "page"
    this._zoomFactor = 1;
    this._currentScale = 1;
    this._fitResizeObserver = null;
    this._headerResizeObserver = null;
    this._headerOutsideClickHandler = null;
    this._currentFitFn = null;
    this._lastKnownControlsWidth = null;
    this._panCleanup = null;
    this._headerDragCleanup = null;
  }

  static DEFAULT_OPTIONS = {
    id: "cypher-almanach-{id}",
    classes: ["cypher-almanach-window", "glassmorphic-journal"],
    tag: "div",
    window: {
      frame: true,
      positioned: true,
      title: "Cypher Almanach",
      icon: "fa-solid fa-book-sparkles",
      resizable: true,
      controls: []
    },
    position: { width: 980, height: 760 },
    actions: {
      selectPage: CypherAlmanachSheet.#onSelectPage,
      createPage: CypherAlmanachSheet.#onCreatePage,
      deletePage: CypherAlmanachSheet.#onDeletePage,
      setMode: CypherAlmanachSheet.#onSetMode,
      toggleFitMode: CypherAlmanachSheet.#onToggleFitMode,
      zoomIn: CypherAlmanachSheet.#onZoomIn,
      zoomOut: CypherAlmanachSheet.#onZoomOut,
      zoomReset: CypherAlmanachSheet.#onZoomReset,
      toggleOverflowMenu: CypherAlmanachSheet.#onToggleOverflowMenu,
      saveContent: CypherAlmanachSheet.#onSaveContent,
      copyUuid: CypherAlmanachSheet.#onCopyUuid,
      configureOwnership: CypherAlmanachSheet.#onConfigureOwnership,
      toggleCypherBar: CypherAlmanachSheet.#onToggleCypherBar,
      shareToPlayers: CypherAlmanachSheet.#onShareToPlayers,
      closeWindow: CypherAlmanachSheet.#onCloseWindow,
      rollStat: CypherAlmanachSheet.#onRollStat,
      rollCypherD20: CypherAlmanachSheet.#onRollCypherD20,
      triggerGMI: CypherAlmanachSheet.#onTriggerGMI
    }
  };

  static PARTS = {
    sheet: {
      template: `modules/${MODULE_ID}/templates/cypher-almanach-sheet.hbs`,
      scrollable: [".almanach-raw-editor", ".almanach-wysiwyg-editor"]
    }
  };

  _replaceHTML(result, content, options) {
    if (!content) return;
    if (result instanceof HTMLElement || result instanceof DocumentFragment) {
      content.replaceChildren(result);
    } else if (typeof result === "string") {
      content.innerHTML = result;
    } else if (result?.sheet instanceof HTMLElement || result?.sheet instanceof DocumentFragment) {
      content.replaceChildren(result.sheet);
    } else {
      super._replaceHTML?.(result, content, options);
    }
  }

  async _prepareContext(options) {
    const context = await super._prepareContext?.(options) || {};
    const doc = this.document;
    context.document = doc;
    context.isEditable = this.isEditable;
    context.isGM = game.user.isGM;
    context.editorMode = this._editorMode;
    context.isPreviewMode = this._editorMode === "preview";
    context.isWysiwygMode = this._editorMode === "wysiwyg";
    context.isCodeMode = this._editorMode === "code";
    context.showCypherBar = this._showCypherBar;
    context.fitMode = this._fitMode;
    context.isFitWidth = this._fitMode === "width";
    context.zoomPercent = Math.round(this._zoomFactor * 100);

    const pages = Array.from(doc?.pages?.values() || []).sort((a, b) => a.sort - b.sort);
    if (!this._activePageId && pages.length > 0) {
      this._activePageId = pages[0].id;
    }

    const activePage = doc?.pages?.get(this._activePageId) || pages[0] || null;
    if (activePage) {
      this._activePageId = activePage.id;
    }

    const authorId = doc?.author?.id ?? null;
    context.canDeletePages = this.isEditable && (game.user.isGM || authorId === game.user.id);

    context.pages = pages.map(p => {
      const tabUi = p.getFlag?.(MODULE_ID, "tabUi") || {};
      return {
        id: p.id,
        name: p.name || "Untitled Page",
        active: p.id === this._activePageId,
        color: tabUi.color || null,
        showCheckbox: !!tabUi.showCheckbox,
        checked: !!tabUi.checked
      };
    });

    context.activePage = activePage;
    context.activePageRawHtml = getPageRawHtml(activePage);

    return context;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const htmlEl = this.element;
    if (!htmlEl) return;

    const docNameInput = htmlEl.querySelector(".almanach-doc-name-input");
    if (docNameInput) {
      const updateTitle = async () => {
        const val = docNameInput.value.trim();
        if (val && val !== this.document.name) {
          await this.document.update({ name: val });
        }
      };
      docNameInput.addEventListener("change", updateTitle);
      docNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          docNameInput.blur();
        }
      });
    }

    if (this._editorMode === "preview" && context.activePage) {
      const container = htmlEl.querySelector(".almanach-rendered-container");
      if (container) {
        this._renderRawHtmlIntoContainer(container, context.activePageRawHtml || "", context.activePage);
      }
    } else {
      this._disconnectFitObserver();
      this._stopWorkbenchAutosave();
    }

    if (this._editorMode === "wysiwyg") {
      htmlEl.querySelectorAll(".wysiwyg-cmd-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const cmd = btn.dataset.cmd;
          const val = btn.dataset.val || null;
          document.execCommand(cmd, false, val);
        });
      });
    }

    this._bindUploadHandlers(htmlEl);
    this._setupResponsiveHeader(htmlEl);
    this._setupCustomHeaderDrag(htmlEl);
    this._setupTabContextMenu(htmlEl);
    this._setupTabsOverflow(htmlEl);

    /* Tab checkboxes — toggling one only greys the tab out; state lives in
     * the page's tabUi flag. Painted in place (no full re-render, so the
     * preview iframe doesn't reload on every tick). */
    if (!this._tabCheckBound) {
      this._tabCheckBound = true;
      htmlEl.addEventListener("change", async (e) => {
        const cb = e.target.closest?.(".tab-check");
        if (!cb || cb.disabled) return;
        cb.closest(".almanach-tab-wrap")?.classList.toggle("checked", cb.checked);
        const page = this.document.pages.get(cb.dataset.pageId);
        if (page) await this._persistTabUi(page, { checked: cb.checked });
      });
    }
  }

  _onClose(options) {
    this._disconnectFitObserver();
    this._disconnectHeaderObserver();
    this._disconnectPanHandlers();
    this._disconnectHeaderDrag();
    this._closeTabMenu();
    this._closeImageMenu();
    this._stopWorkbenchAutosave();
    if (this._tabsOutsideClick) {
      document.removeEventListener("click", this._tabsOutsideClick);
      this._tabsOutsideClick = null;
    }
    return super._onClose?.(options);
  }

  _disconnectFitObserver() {
    if (this._fitResizeObserver) {
      this._fitResizeObserver.disconnect();
      this._fitResizeObserver = null;
    }
    this._currentFitFn = null;
    this._disconnectPanHandlers();
  }

  _disconnectPanHandlers() {
    if (this._panCleanup) {
      this._panCleanup();
      this._panCleanup = null;
    }
  }

  _disconnectHeaderDrag() {
    if (this._headerDragCleanup) {
      this._headerDragCleanup();
      this._headerDragCleanup = null;
    }
  }

  _disconnectHeaderObserver() {
    if (this._headerResizeObserver) {
      this._headerResizeObserver.disconnect();
      this._headerResizeObserver = null;
    }
    if (this._headerOutsideClickHandler) {
      document.removeEventListener("click", this._headerOutsideClickHandler);
      this._headerOutsideClickHandler = null;
    }
  }

  /**
   * Re-implement window dragging via the custom header bar. The native
   * ApplicationV2 `.window-header` drag handle is hidden by CSS for this
   * frameless design, so holding down the left mouse button on empty header
   * space (not on a button, input, or tab) and moving the mouse repositions the
   * window using `setPosition`, exactly like the native title bar would.
   */
  _setupCustomHeaderDrag(htmlEl) {
    this._disconnectHeaderDrag();

    const header = htmlEl.querySelector(".almanach-header");
    if (!header) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, input, a, .almanach-tab-btn, .almanach-uuid-badge, .almanach-overflow-panel, .almanach-tabs-panel")) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const pos = this.position;
      startLeft = pos.left;
      startTop = pos.top;
      header.classList.add("dragging");
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      this.setPosition({ left: startLeft + dx, top: startTop + dy });
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      header.classList.remove("dragging");
    };

    header.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    this._headerDragCleanup = () => {
      header.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }

  /* -------------------------------------------- */
  /*  Tab context menu — rename / color / checkbox */
  /* -------------------------------------------- */

  _setupTabContextMenu(htmlEl) {
    if (this._tabCtxBound) return;
    this._tabCtxBound = true;
    htmlEl.addEventListener("contextmenu", (e) => {
      const wrap = e.target.closest(".almanach-tab-wrap");
      if (!wrap || !this.isEditable) return;
      e.preventDefault();
      this._openTabMenu(e.clientX, e.clientY, wrap.dataset.pageId);
    });
  }

  _closeTabMenu() {
    if (this._tabMenu) {
      this._tabMenu.remove();
      this._tabMenu = null;
      this._tabMenuPageId = null;
    }
    if (this._tabMenuOutside) {
      document.removeEventListener("click", this._tabMenuOutside);
      this._tabMenuOutside = null;
    }
    if (this._tabMenuKey) {
      document.removeEventListener("keydown", this._tabMenuKey);
      this._tabMenuKey = null;
    }
  }

  async _persistTabUi(page, patch) {
    const ui = page.getFlag(MODULE_ID, "tabUi") || {};
    await page.setFlag(MODULE_ID, "tabUi", { ...ui, ...patch });
  }

  _tabWrapFor(pageId) {
    return this.element?.querySelector(`.almanach-tab-wrap[data-page-id="${pageId}"]`);
  }

  /**
   * Fancy glassmorphic popup on right-clicking a page tab: rename, color
   * swatches + custom picker, and an option to put a done-checkbox on the
   * tab. Color and checkbox changes are painted in place and persisted to
   * the page's tabUi flag without a full sheet re-render; rename goes
   * through a normal page update. The menu lives on document.body so the
   * tab strip's overflow-x can't clip it.
   */
  _openTabMenu(x, y, pageId) {
    this._closeTabMenu();
    const page = this.document.pages.get(pageId);
    if (!page) return;
    const ui = page.getFlag(MODULE_ID, "tabUi") || {};
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
    const PRESETS = [
      "#00f0ff", "#e8c95a", "#ff7b72", "#7ee787",
      "#79c0ff", "#d2a8ff", "#ffa657", "#ff9bce", "#9da7b3"
    ];

    const menu = document.createElement("div");
    menu.className = "almanach-tabmenu";
    menu.innerHTML = `
      <div class="tabmenu-title">${esc(page.name)}</div>
      <div class="tabmenu-row">
        <input type="text" class="tabmenu-name" value="${esc(page.name)}" placeholder="Tab name" spellcheck="false">
        <button type="button" class="tabmenu-rename" title="Rename tab"><i class="fa-solid fa-check"></i></button>
      </div>
      <div class="tabmenu-label">Color</div>
      <div class="tabmenu-colors">
        ${PRESETS.map(c =>
          `<button type="button" class="tabmenu-swatch${(ui.color || "").toLowerCase() === c ? " selected" : ""}" data-color="${c}" style="--sw:${c}" title="${c}"></button>`
        ).join("")}
        <input type="color" class="tabmenu-custom" value="${/^#[0-9a-f]{6}$/i.test(ui.color || "") ? ui.color : "#00f0ff"}" title="Custom color">
        <button type="button" class="tabmenu-clear" title="No color"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <label class="tabmenu-check"><input type="checkbox" class="tabmenu-optcheck"${ui.showCheckbox ? " checked" : ""}> Show checkbox on tab</label>
    `;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    this._tabMenu = menu;
    this._tabMenuPageId = pageId;

    const nameInput = menu.querySelector(".tabmenu-name");
    const doRename = async () => {
      const val = nameInput.value.trim();
      this._closeTabMenu();
      if (val && val !== page.name) {
        await page.update({ name: val });
        this.render(true);
      }
    };
    menu.querySelector(".tabmenu-rename").addEventListener("click", doRename);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doRename();
      }
    });

    const deselectSwatches = () =>
      menu.querySelectorAll(".tabmenu-swatch").forEach(s => s.classList.remove("selected"));
    menu.querySelectorAll(".tabmenu-swatch").forEach(sw => {
      sw.addEventListener("click", async () => {
        deselectSwatches();
        sw.classList.add("selected");
        const wrap = this._tabWrapFor(pageId);
        wrap?.style.setProperty("--tab-color", sw.dataset.color);
        await this._persistTabUi(page, { color: sw.dataset.color });
      });
    });
    menu.querySelector(".tabmenu-custom").addEventListener("input", async (e) => {
      deselectSwatches();
      const wrap = this._tabWrapFor(pageId);
      wrap?.style.setProperty("--tab-color", e.target.value);
      await this._persistTabUi(page, { color: e.target.value });
    });
    menu.querySelector(".tabmenu-clear").addEventListener("click", async () => {
      deselectSwatches();
      const wrap = this._tabWrapFor(pageId);
      wrap?.style.removeProperty("--tab-color");
      await this._persistTabUi(page, { color: null });
    });
    menu.querySelector(".tabmenu-optcheck").addEventListener("change", async (e) => {
      const wrap = this._tabWrapFor(pageId);
      if (wrap) {
        wrap.classList.toggle("has-check", e.target.checked);
        if (e.target.checked && !wrap.querySelector(".tab-check")) {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.className = "tab-check";
          cb.dataset.pageId = pageId;
          cb.title = "Toggle done";
          wrap.prepend(cb);
        } else if (!e.target.checked) {
          wrap.querySelector(".tab-check")?.remove();
        }
      }
      await this._persistTabUi(page, { showCheckbox: e.target.checked });
    });

    nameInput.focus();
    nameInput.select();

    this._tabMenuOutside = (e) => {
      if (!menu.contains(e.target)) this._closeTabMenu();
    };
    this._tabMenuKey = (e) => {
      if (e.key === "Escape") this._closeTabMenu();
    };
    setTimeout(() => {
      document.addEventListener("click", this._tabMenuOutside);
      document.addEventListener("keydown", this._tabMenuKey);
    }, 0);
  }

  /* -------------------------------------------- */
  /*  Tabs overflow — fold into dropdown on collision  */
  /* -------------------------------------------- */

  /**
   * When the tab strip grows wide enough to collide with the header control
   * buttons (zoom / fit / mode / share / close on the right), tabs are folded
   * from right to left into a "more tabs" dropdown. The toggle lives at the
   * right end of the tab strip; the panel drops below it. Folded tabs keep
   * full functionality (select, × delete, right-click tab menu, done checkbox).
   *
   * Unlike the old hardcoded ">3 tabs" rule, this is purely geometry-driven:
   * tabs fold only when they actually overlap the controls, and unfold again
   * when there is room. A ResizeObserver on the header re-evaluates on every
   * resize, page add/remove, or rename.
   */
  _setupTabsOverflow(htmlEl) {
    const toggle = htmlEl.querySelector(".almanach-tabs-toggle");
    const panel = htmlEl.querySelector(".almanach-tabs-panel");
    if (!toggle || !panel) return;
    this._tabsOverflowToggle = toggle;
    this._tabsOverflowPanel = panel;
    // Both nodes come from the template and are rebuilt on every render, so
    // the panel always starts closed.
    this._isTabsOverflowOpen = false;

    /* Ensure folded tabs that were moved into the panel on a previous render
     * are restored to the strip so measurement starts from a clean slate.
     * The template re-creates wraps from Handlebars anyway, but DOM nodes
     * could persist across partial re-renders. */
    const strip = htmlEl.querySelector(".almanach-tabs");
    if (strip) {
      for (const w of Array.from(panel.querySelectorAll(":scope > .almanach-tab-wrap"))) {
        strip.insertBefore(w, toggle);
      }
    }

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = !this._isTabsOverflowOpen;
      this._isTabsOverflowOpen = opening;
      if (opening) {
        // Drop the panel directly below the toggle. It lives in the header's
        // controls wrap (the tab strip's overflow-x would clip a dropdown),
        // so it is positioned from the toggle's screen rect instead.
        const r = toggle.getBoundingClientRect();
        panel.style.top = `${r.bottom + 6}px`;
        panel.style.left = `${r.left}px`;
        panel.classList.add("open");
        const pr = panel.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8) {
          panel.style.left = `${Math.max(8, window.innerWidth - pr.width - 8)}px`;
        }
      } else {
        panel.classList.remove("open");
      }
      toggle.classList.toggle("open", this._isTabsOverflowOpen);
    });
    panel.addEventListener("click", (e) => {
      if (e.target.closest(".almanach-tab-btn")) {
        this._isTabsOverflowOpen = false;
        panel.classList.remove("open");
        toggle.classList.remove("open");
      }
    });
    if (!this._tabsOutsideClick) {
      this._tabsOutsideClick = (e) => {
        if (!this._isTabsOverflowOpen) return;
        const p = this._tabsOverflowPanel;
        const t = this._tabsOverflowToggle;
        if (p && !p.contains(e.target) && !(t && t.contains(e.target))) {
          this._isTabsOverflowOpen = false;
          p.classList.remove("open");
          t?.classList.remove("open");
        }
      };
      document.addEventListener("click", this._tabsOutsideClick);
    }

    this._evaluateTabsOverflow();
  }

  /**
   * Geometry-driven tab folding: fold tabs from the right edge of the strip
   * into the dropdown until the strip no longer overlaps the controls wrap.
   * Unfold from the panel back to the strip when there's spare room.
   *
   * How it works:
   *  1. All tab wraps are returned to the strip (clean slate).
   *  2. Measure the controls wrap's left edge — that's the boundary.
   *  3. From the rightmost tab, fold into the panel until the last visible
   *     tab clears the controls with an 8px safety gap.
   *  4. If any tabs were folded, the toggle appears (~36px). Re-check the
   *     last visible tab still clears the toggle; fold more if needed.
   *  5. Update the toggle badge and auto-close the panel if nothing is left.
   *
   * Unfolding happens naturally: every evaluation starts from step 1 (all
   * tabs restored to the strip), so when the window grows, previously folded
   * tabs simply stay in the strip because they fit.
   */
  _evaluateTabsOverflow() {
    const toggle = this._tabsOverflowToggle;
    const panel = this._tabsOverflowPanel;
    if (!toggle || !panel) return;

    const strip = this.element?.querySelector(".almanach-tabs");
    const controlsWrap = this.element?.querySelector(".almanach-controls-wrap");
    if (!strip || !controlsWrap) return;

    /* -- Step 1: restore everything to the strip for clean measurement -- */
    for (const w of Array.from(panel.querySelectorAll(":scope > .almanach-tab-wrap"))) {
      strip.insertBefore(w, toggle);
    }

    const wrapsInStrip = Array.from(
      strip.querySelectorAll(":scope > .almanach-tab-wrap")
    );
    if (wrapsInStrip.length === 0) {
      toggle.style.display = "none";
      return;
    }

    /* -- Step 2: measure available space -- */
    // Temporarily hide the toggle so it doesn't affect measurement.
    toggle.style.display = "none";

    const controlsRect = controlsWrap.getBoundingClientRect();
    const SAFETY_GAP = 8; // breathing room between tabs and controls
    const availableRight = controlsRect.left - SAFETY_GAP;

    /* -- Step 3: fold from right until no overlap -- */
    for (let i = wrapsInStrip.length - 1; i >= 0; i--) {
      const wrap = wrapsInStrip[i];
      const wrapRight = wrap.getBoundingClientRect().right;
      if (wrapRight > availableRight) {
        panel.insertBefore(wrap, panel.firstChild);
      } else {
        // This tab fits — all earlier tabs fit too (they're further left).
        break;
      }
    }

    /* -- Step 4: account for toggle width -- */
    // If tabs were folded, the toggle becomes visible and consumes ~36px
    // at the right end of the strip. Re-check that the last visible tab
    // still clears the controls with the toggle shown; if not, fold more.
    const foldedSoFar = panel.querySelectorAll(":scope > .almanach-tab-wrap").length;
    if (foldedSoFar > 0) {
      toggle.style.display = "";
      const toggleRect = toggle.getBoundingClientRect();
      const remaining = Array.from(
        strip.querySelectorAll(":scope > .almanach-tab-wrap")
      );
      for (let i = remaining.length - 1; i >= 0; i--) {
        const wrapRight = remaining[i].getBoundingClientRect().right;
        if (wrapRight > toggleRect.left - 4) {
          panel.insertBefore(remaining[i], panel.firstChild);
        } else {
          break;
        }
      }
    }

    /* -- Step 5: recount and update toggle badge -- */
    const finalFolded = Array.from(panel.querySelectorAll(":scope > .almanach-tab-wrap"));
    toggle.querySelector(".tabs-badge").textContent = String(finalFolded.length);
    toggle.style.display = finalFolded.length > 0 ? "" : "none";

    if (this._isTabsOverflowOpen && finalFolded.length === 0) {
      this._isTabsOverflowOpen = false;
      panel.classList.remove("open");
      toggle.classList.remove("open");
    }
  }

  /**
   * Watch the header's available width and collapse the inline action buttons
   * into a "more actions" dropdown panel whenever the sheet window is shrunk too
   * narrow to display them all. Buttons are physically moved (not cloned) between
   * `.almanach-controls` and `.almanach-overflow-panel`, so their event listeners
   * keep working identically in either location.
   */
  _setupResponsiveHeader(htmlEl) {
    this._disconnectHeaderObserver();

    const header = htmlEl.querySelector(".almanach-header");
    const controls = htmlEl.querySelector(".almanach-controls");
    const moreBtn = htmlEl.querySelector(".almanach-more-btn");
    const overflowPanel = htmlEl.querySelector(".almanach-overflow-panel");
    const branding = htmlEl.querySelector(".almanach-branding");
    if (!header || !controls || !moreBtn || !overflowPanel) return;

    const MIN_TABS_RESERVED = 70;
    const GAP_BUFFER = 28;

    const measureAndApply = () => {
      const headerWidth = header.clientWidth;
      const brandingWidth = branding?.offsetWidth || 0;
      const isCollapsed = header.classList.contains("collapsed");

      let controlsWidth;
      if (!isCollapsed) {
        controlsWidth = controls.scrollWidth;
        this._lastKnownControlsWidth = controlsWidth;
      } else {
        controlsWidth = this._lastKnownControlsWidth ?? 420;
      }

      const available = headerWidth - brandingWidth - MIN_TABS_RESERVED - GAP_BUFFER;
      const shouldCollapse = available < controlsWidth;

      if (shouldCollapse && !isCollapsed) {
        header.classList.add("collapsed");
        Array.from(controls.children).forEach(child => overflowPanel.appendChild(child));
      } else if (!shouldCollapse && isCollapsed) {
        header.classList.remove("collapsed");
        Array.from(overflowPanel.children).forEach(child => controls.appendChild(child));
        overflowPanel.classList.remove("open");
      }
    };

    measureAndApply();

    this._headerResizeObserver = new ResizeObserver(() => {
      measureAndApply();
      // Re-evaluate tab folding — the strip may need to fold/unfold tabs
      // as the window width changes.
      this._evaluateTabsOverflow();
    });
    this._headerResizeObserver.observe(header);

    this._headerOutsideClickHandler = (e) => {
      if (
        overflowPanel.classList.contains("open") &&
        !overflowPanel.contains(e.target) &&
        e.target !== moreBtn &&
        !moreBtn.contains(e.target)
      ) {
        overflowPanel.classList.remove("open");
      }
    };
    document.addEventListener("click", this._headerOutsideClickHandler);
  }

  /**
   * Render raw HTML with full fidelity via a same-origin `srcdoc` iframe, scale
   * per the active fit mode + zoom factor, and enable click-and-drag panning of
   * the content (scrolling the container) using the current scale to correctly
   * translate mouse movement inside the iframe's unscaled coordinate space into
   * screen-pixel scroll deltas.
   */
  /* -------------------------------------------- */
  /*  Scene Workbench autosave                     */
  /* -------------------------------------------- */

  _stopWorkbenchAutosave() {
    if (this._wbAutosaveInterval) {
      clearInterval(this._wbAutosaveInterval);
      this._wbAutosaveInterval = null;
    }
  }

  /**
   * Uploaded interactive documents built with the Steelbound Scene Workbench
   * keep their state in a private closure and mirror it to localStorage
   * (fixed key `steelbound-scene-workbench-v1`) on every edit. On load they
   * restore from the `#embedded-scene` JSON, NOT localStorage — so to make
   * edits stick, the latest state must be spliced back into that JSON inside
   * the page's rawHtml flag.
   *
   * This polls the iframe's localStorage (2 s) and, when the state drifts
   * from the last checkpoint, writes the updated rawHtml via the standard
   * save path. It detects the document by its `#embedded-scene` script tag,
   * so every page holding a similar document gets the same treatment. The
   * localStorage slot is re-seeded with the page's own state on load
   * because the workbench shares one key across all scenes.
   */
  _setupWorkbenchAutosave(iframe, page) {
    this._stopWorkbenchAutosave();
    if (!this.isEditable || !iframe || !page) return;

    const WB_KEY = "steelbound-scene-workbench-v1";

    let idoc;
    try {
      idoc = iframe.contentDocument;
    } catch {
      return;
    }
    const sceneScript = idoc?.querySelector("script#embedded-scene");
    if (!idoc || !sceneScript) return; // not a Scene Workbench document

    let seed;
    try {
      seed = JSON.parse(sceneScript.textContent.trim());
    } catch {
      return;
    }

    try {
      iframe.contentWindow.localStorage.setItem(WB_KEY, JSON.stringify(seed));
    } catch {
      return;
    }

    let lastState = JSON.stringify(seed);

    this._wbAutosaveInterval = setInterval(() => {
      try {
        const latest = iframe.contentWindow?.localStorage.getItem(WB_KEY);
        if (!latest || latest === lastState) return;
        lastState = latest;
        const currentRaw = getPageRawHtml(page);
        const m = currentRaw.match(/(<script id="embedded-scene" type="application\/json">)([\s\S]*?)(<\/script>)/);
        if (!m) return;
        // Same escaping the workbench applies when serializing.
        const escaped = latest.replace(/</g, "\\u003c");
        const updated =
          currentRaw.slice(0, m.index) + m[1] + escaped + m[3] +
          currentRaw.slice(m.index + m[0].length);
        setPageRawHtml(page, updated).catch(err =>
          console.error("Cypher Almanach | Workbench autosave failed", err)
        );
        console.log("Cypher Almanach | Workbench changes auto-saved to page", page.name);
      } catch (err) {
        console.error("Cypher Almanach | Workbench autosave error", err);
      }
    }, 2000);
  }

  _renderRawHtmlIntoContainer(container, rawHtml, page) {
    this._disconnectFitObserver();
    this._stopWorkbenchAutosave();
    container.innerHTML = "";
    container.removeAttribute("style");
    container.className = "almanach-rendered-container";

    if (!rawHtml || !rawHtml.trim()) return;

    const iframe = document.createElement("iframe");
    iframe.className = "almanach-rendered-iframe";
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("scrolling", "no");
    container.appendChild(iframe);

    const fitToContainer = () => {
      try {
        const idoc = iframe.contentDocument;
        if (!idoc || !idoc.documentElement) return;

        iframe.style.transform = "none";
        iframe.style.width = "100%";
        iframe.style.height = "100%";

        idoc.documentElement.style.overflow = "hidden";
        if (idoc.body) idoc.body.style.overflow = "hidden";

        const contentWidth = Math.max(
          idoc.documentElement.scrollWidth,
          idoc.body?.scrollWidth || 0
        );
        const contentHeight = Math.max(
          idoc.documentElement.scrollHeight,
          idoc.body?.scrollHeight || 0
        );
        if (!contentWidth || !contentHeight) return;

        const containerRect = container.getBoundingClientRect();
        if (!containerRect.width || !containerRect.height) return;

        let baseScale;
        if (this._fitMode === "width") {
          baseScale = containerRect.width / contentWidth;
        } else {
          baseScale = Math.min(containerRect.width / contentWidth, containerRect.height / contentHeight);
        }

        const scale = baseScale * (this._zoomFactor || 1);
        this._currentScale = scale;
        const scaledWidth = contentWidth * scale;
        const scaledHeight = contentHeight * scale;

        iframe.style.width = `${contentWidth}px`;
        iframe.style.height = `${contentHeight}px`;
        iframe.style.transform = `scale(${scale})`;
        iframe.style.transformOrigin = "top left";
        iframe.style.position = "absolute";

        if (this._fitMode === "width") {
          iframe.style.left = "0px";
          iframe.style.top = "0px";
        } else {
          iframe.style.left = `${Math.max(0, (containerRect.width - scaledWidth) / 2)}px`;
          iframe.style.top = `${Math.max(0, (containerRect.height - scaledHeight) / 2)}px`;
        }
      } catch (err) {
        console.warn("Cypher Almanach | Unable to auto-fit iframe content", err);
      }
    };

    iframe.addEventListener("load", () => {
      const idoc = iframe.contentDocument;
      try {
        if (idoc) this._bindCypherDomEvents(idoc);
      } catch (err) {
        console.warn("Cypher Almanach | Unable to bind Cypher triggers inside iframe", err);
      }
      try {
        this._setupWorkbenchAutosave(iframe, page);
      } catch (err) {
        console.warn("Cypher Almanach | Unable to start workbench autosave", err);
      }
      fitToContainer();
      this._setupContentPanning(container, idoc);
    }, { once: true });

    this._fitResizeObserver = new ResizeObserver(() => fitToContainer());
    this._fitResizeObserver.observe(container);
    this._currentFitFn = fitToContainer;

    iframe.srcdoc = rawHtml;
  }

  /**
   * Enable click-and-hold panning: left mouse button down + drag over the
   * rendered content scrolls the container. Listeners are attached directly to
   * the iframe's own same-origin document (rather than an overlay), so buttons
   * and links inside the uploaded HTML remain fully clickable -- a plain click
   * without movement still fires its native click event untouched. Mouse
   * deltas are measured in the iframe's own (unscaled) coordinate space and
   * multiplied by the current render scale to get correct screen-pixel scroll
   * amounts.
   */
  _setupContentPanning(container, idoc) {
    this._disconnectPanHandlers();
    if (!idoc) return;

    let isPanning = false;
    let startX = 0;
    let startY = 0;
    let scrollLeftStart = 0;
    let scrollTopStart = 0;

    const onDown = (e) => {
      if (e.button !== 0) return;
      isPanning = true;
      startX = e.clientX;
      startY = e.clientY;
      scrollLeftStart = container.scrollLeft;
      scrollTopStart = container.scrollTop;
      if (idoc.body) idoc.body.style.userSelect = "none";
      container.classList.add("panning");
    };

    const onMove = (e) => {
      if (!isPanning) return;
      const scale = this._currentScale || 1;
      const dx = (e.clientX - startX) * scale;
      const dy = (e.clientY - startY) * scale;
      container.scrollLeft = scrollLeftStart - dx;
      container.scrollTop = scrollTopStart - dy;
    };

    const onUp = () => {
      if (!isPanning) return;
      isPanning = false;
      if (idoc.body) idoc.body.style.userSelect = "";
      container.classList.remove("panning");
    };

    idoc.addEventListener("mousedown", onDown);
    idoc.addEventListener("mousemove", onMove);
    idoc.addEventListener("mouseup", onUp);
    idoc.addEventListener("mouseleave", onUp);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    this._panCleanup = () => {
      idoc.removeEventListener("mousedown", onDown);
      idoc.removeEventListener("mousemove", onMove);
      idoc.removeEventListener("mouseup", onUp);
      idoc.removeEventListener("mouseleave", onUp);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }

  /** Re-apply scaling live (used by zoom controls) without reloading the iframe. */
  _applyZoomLive() {
    if (this._currentFitFn) {
      this._currentFitFn();
      const zoomLabel = this.element?.querySelector(".almanach-zoom-level");
      if (zoomLabel) zoomLabel.textContent = `${Math.round(this._zoomFactor * 100)}%`;
    } else {
      this.render(true);
    }
  }

  _bindCypherDomEvents(container) {
    // Right-click any image (static or dynamically added, e.g. workbench
    // panels) → fancy image menu. Delegated on the document so late-rendered
    // content is covered without rebinding.
    container.addEventListener("contextmenu", (e) => {
      const img = e.target?.closest?.("img");
      if (img) this._onImageContextMenu(e, img);
    });

    container.querySelectorAll("[data-cypher-roll]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const formula = btn.getAttribute("data-cypher-roll") || "1d20";
        this._executeCypherRoll(formula, btn.getAttribute("data-label") || "Cypher Action");
      });
    });

    container.querySelectorAll("[data-cypher-stat]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const stat = btn.getAttribute("data-cypher-stat");
        const cost = btn.getAttribute("data-cost") || 0;
        this._executeStatCheck(stat, cost);
      });
    });
  }

  /* -------------------------------------------- */
  /*  Image right-click menu                       */
  /* -------------------------------------------- */

  _closeImageMenu() {
    if (this._imgMenu) {
      this._imgMenu.remove();
      this._imgMenu = null;
    }
    if (this._imgMenuKey) {
      document.removeEventListener("keydown", this._imgMenuKey);
      this._imgMenuKey = null;
    }
    if (this._imgMenuOut) {
      document.removeEventListener("mousedown", this._imgMenuOut);
      this._imgMenuOut = null;
    }
  }

  _onImageContextMenu(e, img) {
    e.preventDefault();
    e.stopPropagation();
    const src = img.currentSrc || img.src;
    if (!src) return;
    const fileName = decodeURIComponent(String(src).split("?")[0].split("/").pop() || "");
    const title = img.alt || img.title || fileName || "Image";

    // The event fired inside the preview iframe, which is transform-scaled —
    // convert iframe-viewport coords to page coords before opening the menu
    // in the parent document.
    let x = e.clientX ?? 0;
    let y = e.clientY ?? 0;
    const iframe = this.element?.querySelector?.(".almanach-rendered-iframe");
    if (iframe) {
      const rect = iframe.getBoundingClientRect();
      const scale = this._currentScale || 1;
      x = rect.left + x * scale;
      y = rect.top + y * scale;
    }
    this._openImageMenu(x, y, src, title);
  }

  _openImageMenu(x, y, src, title) {
    this._closeImageMenu();
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
    const isGM = game.user?.isGM;
    const players = (game.users ?? []).filter(u => u.active && !u.isGM);

    const menu = document.createElement("div");
    menu.className = "almanach-imgmenu";
    const item = (action, icon, label, extra = "") =>
      `<button type="button" class="almanach-imgmenu-item" data-img-action="${action}">` +
      `<i class="fas ${icon}"></i><span>${esc(label)}</span>${extra}</button>`;
    menu.innerHTML = `
      ${item("open", "fa-arrow-up-right-from-square", "Open image")}
      ${isGM ? item("share-all", "fa-users", "Show to all players") : ""}
      ${isGM ? `
      <button type="button" class="almanach-imgmenu-item almanach-imgmenu-sub-toggle" data-img-action="toggle-players">
        <i class="fas fa-user-check"></i><span>Show to players</span><i class="fas fa-caret-down almanach-imgmenu-caret"></i>
      </button>
      <div class="almanach-imgmenu-players" hidden>
        ${players.length
          ? players.map(u =>
              `<label class="almanach-imgmenu-player"><input type="checkbox" value="${u.id}" checked> <span>${esc(u.name)}</span></label>`
            ).join("")
          : `<div class="almanach-imgmenu-none">No active players</div>`}
        <button type="button" class="almanach-imgmenu-item almanach-imgmenu-show" data-img-action="share-selected">
          <i class="fas fa-eye"></i><span>Show</span>
        </button>
      </div>` : ""}
      ${item("viewer", "fa-window-maximize", "Show in viewer")}
    `;
    document.body.appendChild(menu);

    // Viewport clamp, same math as the tab context menu.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const px = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
    const py = Math.max(8, Math.min(y, window.innerHeight - mh - 8));
    menu.style.left = `${px}px`;
    menu.style.top = `${py}px`;

    menu.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-img-action]");
      if (!btn) return;
      const action = btn.dataset.imgAction;
      if (action === "toggle-players") {
        const sub = menu.querySelector(".almanach-imgmenu-players");
        if (sub) {
          sub.hidden = !sub.hidden;
          btn.classList.toggle("open", !sub.hidden);
        }
        return;
      }
      if (action === "open") {
        window.open(src, "_blank", "noopener");
      } else if (action === "share-all") {
        const pop = new ImagePopout(src, { title, shareable: true });
        pop.shareImage();
      } else if (action === "share-selected") {
        const ids = Array.from(menu.querySelectorAll(".almanach-imgmenu-player input:checked"))
          .map(i => i.value);
        if (!ids.length) return;
        const pop = new ImagePopout(src, { title, shareable: true, users: ids });
        pop.shareImage();
      } else if (action === "viewer") {
        new AlmanachImageViewer({
          id: `cypher-almanach-image-viewer-${foundry.utils.randomID()}`,
          src,
          title
        }).render(true);
      }
      this._closeImageMenu();
    });

    this._imgMenuOut = (ev) => {
      if (this._imgMenu && !this._imgMenu.contains(ev.target)) this._closeImageMenu();
    };
    this._imgMenuKey = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this._closeImageMenu();
      }
    };
    setTimeout(() => document.addEventListener("mousedown", this._imgMenuOut), 0);
    document.addEventListener("keydown", this._imgMenuKey);

    this._imgMenu = menu;
  }

  _bindUploadHandlers(htmlEl) {
    const fileInput = htmlEl.querySelector(".almanach-file-input");
    if (fileInput) {
      fileInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (file) await this._loadHtmlFile(file);
      });
    }

    const dropZone = htmlEl.querySelector(".drop-zone");
    if (dropZone) {
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
      });
      dropZone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
      });
      dropZone.addEventListener("drop", async (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          await this._loadHtmlFile(file);
        }
      });
    }
  }

  async _loadHtmlFile(file) {
    if (!this.isEditable) return;
    try {
      const text = await file.text();
      const doc = this.document;
      let page = doc.pages.get(this._activePageId);

      if (!page) {
        const pageName = file.name.replace(/\.[^/.]+$/, "");
        const created = await doc.createEmbeddedDocuments("JournalEntryPage", [{
          name: pageName,
          type: "text",
          text: { content: PLACEHOLDER_TEXT_CONTENT, format: 1 },
          flags: { [MODULE_ID]: { [RAW_HTML_FLAG]: text } }
        }]);
        this._activePageId = created[0].id;
      } else {
        await setPageRawHtml(page, text);
      }

      ui.notifications.info(game.i18n.format("CYPHER_ALMANACH.Notifications.FileLoaded", { file: file.name }));
      this._editorMode = "preview";
      this._zoomFactor = 1;
      this.render(true);
    } catch (err) {
      console.error("Cypher Almanach | Failed to load HTML file", err);
      ui.notifications.error(game.i18n.localize("CYPHER_ALMANACH.Notifications.InvalidFile"));
    }
  }

  static #onSelectPage(event, target) {
    const pageId = target.dataset.pageId;
    if (pageId) {
      this._activePageId = pageId;
      this._zoomFactor = 1;
      this.render(true);
    }
  }

  static async #onCreatePage(event, target) {
    if (!this.isEditable) return;
    const doc = this.document;
    const count = doc.pages.size + 1;
    const created = await doc.createEmbeddedDocuments("JournalEntryPage", [{
      name: `Page ${count}`,
      type: "text",
      text: { content: PLACEHOLDER_TEXT_CONTENT, format: 1 },
      flags: { [MODULE_ID]: { [RAW_HTML_FLAG]: "<h1>New Page</h1><p>Start typing or paste HTML here.</p>" } }
    }]);
    this._activePageId = created[0].id;
    this._zoomFactor = 1;
    this.render(true);
  }

  static async #onDeletePage(event, target) {
    event.stopPropagation();
    if (!this.isEditable) return;
    const doc = this.document;
    const pageId = target.dataset.pageId;
    if (!pageId) return;
    const page = doc.pages.get(pageId);
    if (!page) return;
    try {
      await doc.deleteEmbeddedDocuments("JournalEntryPage", [pageId]);
    } catch (err) {
      console.error("Cypher Almanach | Failed to delete page", err);
      ui.notifications.error(`Failed to delete page "${page.name}".`);
      return;
    }
    if (this._activePageId === pageId) this._activePageId = null;
    this.render(true);
  }

  static #onSetMode(event, target) {
    const mode = target.dataset.mode;
    if (mode) {
      this._editorMode = mode;
      this.render(true);
    }
  }

  static #onToggleFitMode(event, target) {
    this._fitMode = this._fitMode === "width" ? "page" : "width";
    this._zoomFactor = 1;
    this.render(true);
  }

  static #onZoomIn(event, target) {
    this._zoomFactor = Math.min(3, Math.round((this._zoomFactor + 0.1) * 100) / 100);
    this._applyZoomLive();
  }

  static #onZoomOut(event, target) {
    this._zoomFactor = Math.max(0.2, Math.round((this._zoomFactor - 0.1) * 100) / 100);
    this._applyZoomLive();
  }

  static #onZoomReset(event, target) {
    this._zoomFactor = 1;
    this._applyZoomLive();
  }

  static #onToggleOverflowMenu(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const panel = this.element?.querySelector(".almanach-overflow-panel");
    panel?.classList.toggle("open");
  }

  static async #onSaveContent(event, target) {
    if (!this.isEditable || !this._activePageId) return;
    const htmlEl = this.element;
    const pageTitleInput = htmlEl.querySelector(".almanach-page-title-input");
    const docNameInput = htmlEl.querySelector(".almanach-doc-name-input");

    if (docNameInput && docNameInput.value.trim() && docNameInput.value.trim() !== this.document.name) {
      await this.document.update({ name: docNameInput.value.trim() });
    }

    let newContent = null;
    if (this._editorMode === "code") {
      const textarea = htmlEl.querySelector(".almanach-raw-editor");
      if (textarea) newContent = textarea.value;
    } else if (this._editorMode === "wysiwyg") {
      const wysiwyg = htmlEl.querySelector(".almanach-wysiwyg-editor");
      if (wysiwyg) newContent = wysiwyg.innerHTML;
    }

    const doc = this.document;
    const page = doc.pages.get(this._activePageId);
    if (page) {
      const extraUpdates = {};
      if (pageTitleInput && pageTitleInput.value.trim()) extraUpdates["name"] = pageTitleInput.value.trim();

      if (newContent !== null) {
        await setPageRawHtml(page, newContent, extraUpdates);
      } else if (Object.keys(extraUpdates).length) {
        await page.update(extraUpdates);
      }

      ui.notifications.info(game.i18n.localize("CYPHER_ALMANACH.Notifications.Saved"));
      this._editorMode = "preview";
      this._zoomFactor = 1;
      this.render(true);
    }
  }

  static async #onCopyUuid(event, target) {
    const doc = this.document;
    const uuidString = `@UUID[${doc.uuid}]{${doc.name}}`;

    if (game.clipboard?.copyText) {
      await game.clipboard.copyText(uuidString);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(uuidString);
    }

    ui.notifications.info(game.i18n.format("CYPHER_ALMANACH.Notifications.UuidCopied", { uuid: uuidString }));
  }

  static #onConfigureOwnership(event, target) {
    if (!game.user.isGM) return;
    const OwnershipConfigClass = foundry.applications?.apps?.DocumentOwnershipConfig || DocumentOwnershipConfig;
    if (OwnershipConfigClass) {
      new OwnershipConfigClass(this.document).render(true);
    }
  }

  static #onToggleCypherBar(event, target) {
    this._showCypherBar = !this._showCypherBar;
    this.render(true);
  }

  static #onShareToPlayers(event, target) {
    if (!game.user.isGM) return;
    this._openShareDialog();
  }

  _openShareDialog() {
    const doc = this.document;
    const activePageId = this._activePageId;
    const nonGMUsers = game.users.filter(u => !u.isGM);

    let playerRows = "";
    if (nonGMUsers.length === 0) {
      playerRows = `<div class="share-no-players">${game.i18n.localize("CYPHER_ALMANACH.ShareDialog.NoPlayers")}</div>`;
    } else {
      nonGMUsers.forEach(u => {
        const activeBadge = u.active
          ? `<span class="player-status active"><i class="fa-solid fa-circle"></i> ${game.i18n.localize("CYPHER_ALMANACH.ShareDialog.ActiveOnly")}</span>`
          : `<span class="player-status offline"><i class="fa-regular fa-circle"></i> ${game.i18n.localize("CYPHER_ALMANACH.ShareDialog.Offline")}</span>`;

        playerRows += `
          <label class="share-player-item ${u.active ? "is-online" : "is-offline"}">
            <input type="checkbox" class="player-checkbox" name="user_${u.id}" value="${u.id}" />
            <span class="player-name">${u.name}</span>
            ${activeBadge}
          </label>
        `;
      });
    }

    const dialogHtml = `
      <form class="almanach-share-form">
        <div class="share-desc">
          ${game.i18n.format("CYPHER_ALMANACH.ShareDialog.Header", { title: doc.name })}
        </div>
        <div class="share-options-box">
          <label class="share-player-item all-players-option">
            <input type="checkbox" class="all-players-checkbox" name="all_players" value="all" checked />
            <span class="player-name"><strong><i class="fa-solid fa-users"></i> ${game.i18n.localize("CYPHER_ALMANACH.ShareDialog.AllPlayers")}</strong></span>
          </label>
          <hr class="share-divider" />
          <div class="share-players-list custom-scroll">
            ${playerRows}
          </div>
        </div>
      </form>
    `;

    const dialog = new Dialog({
      title: game.i18n.localize("CYPHER_ALMANACH.ShareDialog.Title"),
      content: dialogHtml,
      buttons: {
        show: {
          icon: '<i class="fa-solid fa-bullhorn"></i>',
          label: game.i18n.localize("CYPHER_ALMANACH.ShareDialog.ShowBtn"),
          callback: async (html) => {
            const root = html instanceof HTMLElement ? html : html[0];
            const allCheckbox = root.querySelector(".all-players-checkbox");
            const checkedPlayers = Array.from(root.querySelectorAll(".player-checkbox:checked")).map(cb => cb.value);

            if (allCheckbox?.checked || checkedPlayers.length === 0) {
              await doc.show(activePageId, { force: true });
              ui.notifications.info(game.i18n.format("CYPHER_ALMANACH.Notifications.SharedAll", { name: doc.name }));
            } else {
              await doc.show(activePageId, { force: true, users: checkedPlayers });
              ui.notifications.info(game.i18n.format("CYPHER_ALMANACH.Notifications.SharedSelected", {
                name: doc.name,
                count: checkedPlayers.length
              }));
            }
          }
        },
        cancel: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: game.i18n.localize("CYPHER_ALMANACH.ShareDialog.CancelBtn"),
          callback: () => {}
        }
      },
      default: "show",
      render: (html) => {
        const root = html instanceof HTMLElement ? html : html[0];
        const allCheckbox = root.querySelector(".all-players-checkbox");
        const playerCheckboxes = root.querySelectorAll(".player-checkbox");
        if (!allCheckbox) return;

        allCheckbox.addEventListener("change", () => {
          if (allCheckbox.checked) {
            playerCheckboxes.forEach(cb => { cb.checked = false; });
          }
        });

        playerCheckboxes.forEach(cb => {
          cb.addEventListener("change", () => {
            const anyChecked = Array.from(playerCheckboxes).some(c => c.checked);
            allCheckbox.checked = !anyChecked;
          });
        });
      }
    }, {
      classes: ["cypher-almanach-dialog", "glassmorphic-dialog"],
      width: 440
    });

    dialog.render(true);
  }

  static #onCloseWindow(event, target) {
    this.close();
  }

  static #onRollStat(event, target) {
    const stat = target.dataset.stat || "Stat";
    this._executeStatCheck(stat, 0);
  }

  static #onRollCypherD20(event, target) {
    this._executeCypherRoll("1d20", "Cypher Task Check");
  }

  static #onTriggerGMI(event, target) {
    ChatMessage.create({
      content: `
        <div class="cypher-chat-card gm-intrusion">
          <div class="card-header"><i class="fa-solid fa-triangle-exclamation"></i> <strong>GM INTRUSION!</strong></div>
          <p>The Game Master introduces an unexpected complication or twist. The player gains 2 XP (1 to keep, 1 to award to a fellow player).</p>
        </div>
      `
    });
  }

  async _executeCypherRoll(formula = "1d20", label = "Cypher Roll") {
    const roll = await new Roll(formula).evaluate();
    const result = roll.total;
    let extra = "";

    if (formula === "1d20") {
      if (result === 1) {
        extra = `<div class="roll-special gmi"><i class="fa-solid fa-triangle-exclamation"></i> <strong>GM INTRUSION (Natural 1)</strong></div>`;
      } else if (result === 17) {
        extra = `<div class="roll-special minor">+1 Damage</div>`;
      } else if (result === 18) {
        extra = `<div class="roll-special minor">+2 Damage</div>`;
      } else if (result === 19) {
        extra = `<div class="roll-special major">Minor Effect (+3 Damage or Effect)</div>`;
      } else if (result === 20) {
        extra = `<div class="roll-special major">Major Effect (+4 Damage or Major Effect)</div>`;
      }
    }

    const difficultyBeat = Math.floor(result / 3);

    const content = `
      <div class="cypher-chat-card">
        <div class="card-header"><i class="fa-solid fa-atom"></i> <strong>${label}</strong></div>
        <div class="card-result">Result: <span class="result-number">${result}</span> (Beats Difficulty Level ${difficultyBeat})</div>
        ${extra}
      </div>
    `;

    roll.toMessage({ speaker: ChatMessage.getSpeaker(), flavor: content });
  }

  async _executeStatCheck(stat, cost = 0) {
    this._executeCypherRoll("1d20", `${stat} Task Check (Cost: ${cost})`);
  }
}

async function createCypherAlmanach(folderId = null, name = "New Cypher Almanach") {
  const welcomeRawHtml = `
    <div class="almanach-welcome">
      <h1 style="color: #00f0ff; border-bottom: 1px solid rgba(0, 240, 255, 0.3); padding-bottom: 8px;">CYPHER ALMANACH</h1>
      <p>Welcome to your new modern glassmorphic journal. You can write or paste <strong>pure unsanitized HTML/JS</strong> (including full documents with &lt;style&gt; and &lt;body&gt; attributes), edit visually with the <strong>WYSIWYG editor</strong>, or drop <code>.html</code> files right here. Click and drag the document to pan it, and hold the header to move this window.</p>
      <div style="margin-top: 16px; display: flex; gap: 8px;">
        <button class="cypher-badge stat-might" data-cypher-roll="1d20" data-label="Might Action Check"><i class="fa-solid fa-hand-fist"></i> Test Might Roll</button>
        <button class="cypher-badge stat-speed" data-cypher-roll="1d20" data-label="Speed Action Check"><i class="fa-solid fa-bolt"></i> Test Speed Roll</button>
      </div>
    </div>
  `;

  const created = await JournalEntry.create({
    name: name,
    folder: folderId,
    flags: { core: { sheetClass: SHEET_CLASS_ID } },
    pages: [{
      name: "Overview",
      type: "text",
      text: { content: PLACEHOLDER_TEXT_CONTENT, format: 1 },
      flags: { [MODULE_ID]: { [RAW_HTML_FLAG]: welcomeRawHtml } }
    }]
  }, { renderSheet: true });

  return created;
}

async function createStandardJournal(folderId = null, name = "New WYSIWYG Journal") {
  const created = await JournalEntry.create({
    name: name,
    folder: folderId,
    pages: [{
      name: "Page 1",
      type: "text",
      text: { content: "<p>Start writing your journal entry with the standard WYSIWYG editor...</p>", format: 1 }
    }]
  }, { renderSheet: true });

  return created;
}

async function promptJournalCreateDialog(data = {}, options = {}) {
  const folders = game.folders.filter(f => f.type === "JournalEntry");
  let folderOptions = `<option value="">${game.i18n.localize("None")}</option>`;
  folders.forEach(f => {
    const selected = (data.folder === f.id) ? "selected" : "";
    folderOptions += `<option value="${f.id}" ${selected}>${f.name}</option>`;
  });

  const content = `
    <form class="cypher-almanach-create-form" style="display: flex; flex-direction: column; gap: 12px;">
      <div class="form-group">
        <label style="font-weight: 600; color: #00f0ff;"><i class="fa-solid fa-heading"></i> ${game.i18n.localize("Name")}</label>
        <div class="form-fields">
          <input type="text" name="name" placeholder="Enter entry name..." value="${data.name || ""}" autofocus required />
        </div>
      </div>
      <div class="form-group">
        <label style="font-weight: 600; color: #00f0ff;"><i class="fa-solid fa-pen-to-square"></i> ${game.i18n.localize("CYPHER_ALMANACH.DialogTypeLabel")}</label>
        <div class="form-fields">
          <select name="sheetType" style="width: 100%; padding: 6px; font-weight: 500;">
            <option value="${SHEET_CLASS_ID}" selected>⭐ ${game.i18n.localize("CYPHER_ALMANACH.OptionAlmanach")}</option>
            <option value="standard">📝 ${game.i18n.localize("CYPHER_ALMANACH.OptionDefault")}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label style="font-weight: 600; color: #8b949e;"><i class="fa-solid fa-folder"></i> ${game.i18n.localize("Folder")}</label>
        <div class="form-fields">
          <select name="folder" style="width: 100%; padding: 4px;">
            ${folderOptions}
          </select>
        </div>
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    new Dialog({
      title: game.i18n.localize("CYPHER_ALMANACH.DialogTitle"),
      content: content,
      buttons: {
        create: {
          icon: '<i class="fa-solid fa-check"></i>',
          label: game.i18n.localize("Create"),
          callback: async (html) => {
            const form = html[0].querySelector("form");
            const name = form.querySelector('[name="name"]').value.trim() || "New Journal Entry";
            const sheetType = form.querySelector('[name="sheetType"]').value;
            const folder = form.querySelector('[name="folder"]').value || null;

            if (sheetType === SHEET_CLASS_ID) {
              const doc = await createCypherAlmanach(folder, name);
              resolve(doc);
            } else {
              const doc = await createStandardJournal(folder, name);
              resolve(doc);
            }
          }
        },
        cancel: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: game.i18n.localize("Cancel"),
          callback: () => resolve(null)
        }
      },
      default: "create"
    }).render(true);
  });
}

Hooks.once("init", async function () {
  console.log("Cypher Almanach | Initializing Modern Glassmorphic Journal Module (labeled overflow menu)");

  try {
    foundry.applications.apps.DocumentSheetConfig.registerSheet(JournalEntry, MODULE_ID, CypherAlmanachSheet, {
      label: "CYPHER_ALMANACH.SheetName",
      makeDefault: false
    });
  } catch (e) {
    Journal.registerSheet(MODULE_ID, CypherAlmanachSheet, {
      label: "CYPHER_ALMANACH.SheetName",
      makeDefault: false
    });
  }

  const originalCreateDialog = JournalEntry.createDialog;
  JournalEntry.createDialog = function (data = {}, options = {}) {
    return promptJournalCreateDialog(data, options);
  };

  game.cypherAlmanach = {
    createAlmanach: createCypherAlmanach,
    createStandardJournal: createStandardJournal,
    createDialog: promptJournalCreateDialog,
    CypherAlmanachSheet: CypherAlmanachSheet,
    getPageRawHtml: getPageRawHtml,
    setPageRawHtml: setPageRawHtml
  };
});

Hooks.on("renderJournalDirectory", (app, html, data) => {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;

  const createEntryBtn = root.querySelector(".create-entry");
  if (createEntryBtn && !createEntryBtn.dataset.almanachHooked) {
    createEntryBtn.dataset.almanachHooked = "true";
    createEntryBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      promptJournalCreateDialog();
    }, true);
  }

  const actionButtons = root.querySelector(".header-actions.action-buttons") || root.querySelector(".action-buttons");
  if (actionButtons && !actionButtons.querySelector(".create-almanach-btn")) {
    const createAlmanachBtn = document.createElement("button");
    createAlmanachBtn.type = "button";
    createAlmanachBtn.className = "create-almanach-btn";
    createAlmanachBtn.innerHTML = `<i class="fa-solid fa-atom"></i> ${game.i18n.localize("CYPHER_ALMANACH.CreateAlmanachButton")}`;
    createAlmanachBtn.title = "Directly create a modern Cypher Almanach Journal Entry";
    createAlmanachBtn.addEventListener("click", (e) => {
      e.preventDefault();
      createCypherAlmanach();
    });

    const createStandardBtn = document.createElement("button");
    createStandardBtn.type = "button";
    createStandardBtn.className = "create-standard-btn";
    createStandardBtn.innerHTML = `<i class="fa-solid fa-pen-nib"></i> ${game.i18n.localize("CYPHER_ALMANACH.CreateStandardButton")}`;
    createStandardBtn.title = "Create a standard Journal with the WYSIWYG editor";
    createStandardBtn.addEventListener("click", (e) => {
      e.preventDefault();
      createStandardJournal();
    });

    actionButtons.appendChild(createAlmanachBtn);
    actionButtons.appendChild(createStandardBtn);
  }
});

Hooks.on("getJournalDirectoryFolderContext", (html, entryOptions) => {
  entryOptions.push({
    name: "CYPHER_ALMANACH.CreateInFolder",
    icon: '<i class="fa-solid fa-atom"></i>',
    condition: () => game.user.isGM,
    callback: header => {
      const li = header.closest(".directory-item") || header[0]?.closest?.(".directory-item");
      const folderId = li?.dataset?.folderId || null;
      promptJournalCreateDialog({ folder: folderId });
    }
  });

  entryOptions.push({
    name: "CYPHER_ALMANACH.CreateStandardInFolder",
    icon: '<i class="fa-solid fa-pen-nib"></i>',
    condition: () => game.user.isGM,
    callback: header => {
      const li = header.closest(".directory-item") || header[0]?.closest?.(".directory-item");
      const folderId = li?.dataset?.folderId || null;
      createStandardJournal(folderId);
    }
  });
});

Hooks.on("getJournalDirectoryEntryContext", (html, entryOptions) => {
  entryOptions.push({
    name: "CYPHER_ALMANACH.Controls.Share",
    icon: '<i class="fa-solid fa-bullhorn"></i>',
    condition: () => game.user.isGM,
    callback: header => {
      const li = header.closest(".directory-item") || header[0]?.closest?.(".directory-item");
      const entryId = li?.dataset?.documentId || li?.dataset?.entryId;
      const entry = game.journal.get(entryId);
      if (entry) {
        if (entry.sheet instanceof CypherAlmanachSheet) {
          entry.sheet._openShareDialog();
        } else {
          entry.show(null, { force: true });
        }
      }
    }
  });

  entryOptions.push({
    name: "CYPHER_ALMANACH.Controls.CopyUuid",
    icon: '<i class="fa-solid fa-passport"></i>',
    condition: () => true,
    callback: header => {
      const li = header.closest(".directory-item") || header[0]?.closest?.(".directory-item");
      const entryId = li?.dataset?.documentId || li?.dataset?.entryId;
      const entry = game.journal.get(entryId);
      if (entry) {
        const uuidString = `@UUID[${entry.uuid}]{${entry.name}}`;
        if (game.clipboard?.copyText) {
          game.clipboard.copyText(uuidString);
        } else if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(uuidString);
        }
        ui.notifications.info(game.i18n.format("CYPHER_ALMANACH.Notifications.UuidCopied", { uuid: uuidString }));
      }
    }
  });
});
