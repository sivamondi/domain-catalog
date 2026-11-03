(function () {
  'use strict';
  const base = document.body.dataset.base || '/';
  const root = document.documentElement;

  // Colour mode
  document.querySelector('.dc-color')?.addEventListener('click', () => {
    const dark = root.dataset.color ? root.dataset.color === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.color = dark ? 'light' : 'dark';
    try { localStorage.setItem('dc-color', root.dataset.color); } catch (e) { /* storage may be blocked */ }
    renderMermaid(true);
  });

  // Menu: collapses to icons on wide screens and slides in as a drawer on narrow ones.
  const menuButton = document.querySelector('.dc-menu');
  if (menuButton) {
    const narrow = matchMedia('(max-width: 900px)');
    const sidebar = document.getElementById('dc-sidebar');
    const backdrop = document.querySelector('.dc-side-backdrop');
    const background = [document.querySelector('.dc-top'), document.querySelector('.dc-content')];
    const sync = () => {
      const open = narrow.matches ? root.dataset.drawer === 'open' : root.dataset.sidebar !== 'collapsed';
      menuButton.setAttribute('aria-expanded', String(open));
    };
    const closeDrawer = (restoreFocus) => {
      if (root.dataset.drawer !== 'open') return;
      delete root.dataset.drawer;
      backdrop.hidden = true;
      background.forEach((el) => { el.inert = false; });
      sync();
      if (restoreFocus) menuButton.focus();
    };
    const openDrawer = () => {
      root.dataset.drawer = 'open';
      backdrop.hidden = false;
      // Inert background keeps keyboard focus inside the drawer.
      background.forEach((el) => { el.inert = true; });
      sync();
      sidebar.getBoundingClientRect(); // A hidden element can't take focus, so apply the open styles first.
      sidebar.querySelector('.dc-side-close').focus();
    };
    menuButton.addEventListener('click', () => {
      if (narrow.matches) {
        openDrawer();
        return;
      }
      if (root.dataset.sidebar === 'collapsed') delete root.dataset.sidebar;
      else root.dataset.sidebar = 'collapsed';
      try {
        if (root.dataset.sidebar) localStorage.setItem('dc-sidebar', 'collapsed');
        else localStorage.removeItem('dc-sidebar');
      } catch (e) { /* storage may be blocked */ }
      sync();
    });
    sidebar.querySelector('.dc-side-close').addEventListener('click', () => closeDrawer(true));
    backdrop.addEventListener('click', () => closeDrawer(true));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(true); });
    narrow.addEventListener('change', () => { closeDrawer(false); sync(); });
    sync();
  }

  // Copy buttons
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('.dc-copy');
    if (!button) return;
    const source = button.parentElement.querySelector('pre code, .dc-prompt-body');
    try {
      await navigator.clipboard.writeText(source.textContent);
      button.textContent = 'Copied';
    } catch (e) {
      button.textContent = 'Failed';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  });

  // Version switcher
  document.querySelector('.dc-version-select')?.addEventListener('change', (e) => { location.href = e.target.value; });

  // Code tabs
  document.querySelectorAll('.dc-codetabs').forEach((group) => {
    const blocks = [...group.querySelectorAll(':scope > .dc-code')];
    if (blocks.length < 2) return;
    const tabs = document.createElement('div');
    tabs.className = 'dc-code-tabs';
    tabs.setAttribute('role', 'tablist');
    const select = (index) => {
      blocks.forEach((b, i) => { b.hidden = i !== index; });
      [...tabs.children].forEach((t, i) => t.setAttribute('aria-selected', String(i === index)));
    };
    blocks.forEach((block, i) => {
      const title = block.querySelector('.dc-code-title');
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.textContent = title ? title.textContent : `Tab ${i + 1}`;
      if (title) title.remove();
      tab.addEventListener('click', () => select(i));
      tabs.appendChild(tab);
    });
    group.prepend(tabs);
    select(0);
  });

  // Table filtering and sorting
  document.querySelectorAll('.dc-filters').forEach((bar) => {
    const table = bar.parentElement.querySelector('table');
    if (!table) return;
    const text = bar.querySelector('.dc-table-filter');
    const owner = bar.querySelector('.dc-owner-filter');
    const count = bar.querySelector('.dc-count');
    const apply = () => {
      const needle = (text?.value || '').toLowerCase().trim();
      const who = owner?.value || '';
      let shown = 0;
      table.querySelectorAll('tbody tr').forEach((row) => {
        const match = (!needle || row.dataset.search.includes(needle)) && (!who || (row.dataset.owner || '').split(' ').includes(who));
        row.hidden = !match;
        if (match) shown += 1;
      });
      if (count) count.textContent = `${shown} results`;
    };
    text?.addEventListener('input', apply);
    owner?.addEventListener('change', apply);
  });
  document.querySelectorAll('table.dc-sortable').forEach((table) => {
    table.querySelectorAll('thead th').forEach((th, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dc-sort';
      button.textContent = th.textContent;
      th.textContent = '';
      th.appendChild(button);
      button.addEventListener('click', () => {
        const dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        table.querySelectorAll('thead th').forEach((other) => other.removeAttribute('aria-sort'));
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        const body = table.tBodies[0];
        [...body.rows].sort((a, b) => dir * a.cells[index].textContent.trim().localeCompare(b.cells[index].textContent.trim(), undefined, { numeric: true })).forEach((row) => body.appendChild(row));
      });
    });
  });

  // Search
  const dialog = document.querySelector('.dc-search');
  let searchIndex = null;
  const input = dialog?.querySelector('input');
  const results = dialog?.querySelector('.dc-search-results');
  const escapeText = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
  const openSearch = async () => {
    dialog.showModal();
    input.select();
    if (!searchIndex) {
      try {
        searchIndex = await (await fetch(`${base}search.json`)).json();
      } catch (e) {
        results.innerHTML = '<li class="muted">Search index could not be loaded.</li>';
      }
    }
  };
  const runSearch = () => {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !searchIndex) { results.innerHTML = ''; return; }
    const scored = [];
    for (const item of searchIndex) {
      const title = item.title.toLowerCase();
      const id = String(item.id).toLowerCase();
      const summary = (item.summary || '').toLowerCase();
      const text = (item.text || '').toLowerCase();
      let score = 0;
      for (const term of terms) {
        let hit = 0;
        if (title === term || id === term) hit = 12;
        else if (title.startsWith(term)) hit = 8;
        else if (title.includes(term) || id.includes(term)) hit = 6;
        else if (summary.includes(term)) hit = 3;
        else if (text.includes(term)) hit = 1;
        if (!hit) { score = 0; break; }
        score += hit;
      }
      if (score) scored.push([score, item]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    results.innerHTML = scored.slice(0, 30).map(([, item]) => `<li><a href="${escapeText(item.url)}"><strong>${escapeText(item.title)}</strong> <span class="dc-flag">${escapeText(item.type)}</span><span class="muted">${escapeText(item.summary)}</span></a></li>`).join('') || '<li class="muted">No matches.</li>';
  };
  input?.addEventListener('input', runSearch);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') results.querySelector('a')?.click();
  });
  dialog?.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.querySelector('.dc-search-open')?.addEventListener('click', openSearch);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  });

  // Graph pan, zoom, find, fullscreen and export
  document.querySelectorAll('.dc-graph').forEach((figure) => {
    const svg = figure.querySelector('svg');
    const world = svg.querySelector('.dc-graph-world');
    const width = Number(svg.dataset.w);
    const height = Number(svg.dataset.h);
    svg.removeAttribute('viewBox');
    let view = { x: 0, y: 0, k: 1 };
    const apply = () => { world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`; };

    // Movable boxes: a drag places a box and redraws only the connectors touching it.
    const nodes = new Map();
    const edgesByNode = new Map();
    const firstBox = svg.querySelector('.dc-node-box');
    const nodeW = firstBox ? Number(firstBox.getAttribute('width')) : 0;
    const nodeH = firstBox ? Number(firstBox.getAttribute('height')) : 0;
    svg.querySelectorAll('.dc-node').forEach((el) => {
      const cx = Number(el.dataset.cx);
      const cy = Number(el.dataset.cy);
      nodes.set(el.dataset.node, { el, cx, cy, startCx: cx, startCy: cy });
    });
    const edges = [...svg.querySelectorAll('.dc-edge-group')].map((el) => {
      const path = el.querySelector('.dc-edge');
      const label = el.querySelector('.dc-edge-label');
      const edge = { el, path, label, d: path.getAttribute('d'), lx: label?.getAttribute('x'), ly: label?.getAttribute('y') };
      for (const key of [el.dataset.from, el.dataset.to]) {
        if (!edgesByNode.has(key)) edgesByNode.set(key, []);
        edgesByNode.get(key).push(edge);
      }
      return edge;
    });
    const movedNodes = new Set();
    const layoutKey = `dc-layout:${base}:${figure.getAttribute('aria-label')}`;
    const resetButton = figure.querySelector('[data-graph="reset"]');
    const route = (edge) => {
      const a = nodes.get(edge.el.dataset.from);
      const b = nodes.get(edge.el.dataset.to);
      if (!a || !b) return;
      const dx = b.cx - a.cx;
      const dy = b.cy - a.cy;
      let d;
      let lx;
      let ly;
      if (Math.abs(dx) >= nodeW * 0.75 || Math.abs(dx) >= Math.abs(dy)) {
        const dir = dx < 0 ? -1 : 1;
        const [sx, ex] = [a.cx + dir * nodeW / 2, b.cx - dir * nodeW / 2];
        const mid = (sx + ex) / 2;
        d = `M${sx} ${a.cy} L${mid} ${a.cy} L${mid} ${b.cy} L${ex} ${b.cy}`;
        [lx, ly] = [mid, (a.cy + b.cy) / 2 - 5];
      } else {
        const dir = dy < 0 ? -1 : 1;
        const [sy, ey] = [a.cy + dir * nodeH / 2, b.cy - dir * nodeH / 2];
        const mid = (sy + ey) / 2;
        d = `M${a.cx} ${sy} L${a.cx} ${mid} L${b.cx} ${mid} L${b.cx} ${ey}`;
        [lx, ly] = [(a.cx + b.cx) / 2, mid - 5];
      }
      edge.path.setAttribute('d', d);
      edge.label?.setAttribute('x', lx);
      edge.label?.setAttribute('y', ly);
    };
    const place = (key, cx, cy) => {
      const node = nodes.get(key);
      node.cx = cx;
      node.cy = cy;
      node.el.dataset.cx = cx;
      node.el.dataset.cy = cy;
      node.el.setAttribute('transform', `translate(${cx - nodeW / 2} ${cy - nodeH / 2})`);
      (edgesByNode.get(key) || []).forEach(route);
    };
    const saveLayout = () => {
      resetButton.hidden = movedNodes.size === 0;
      try {
        if (!movedNodes.size) {
          localStorage.removeItem(layoutKey);
          return;
        }
        localStorage.setItem(layoutKey, JSON.stringify(Object.fromEntries([...movedNodes].map((key) => [key, [nodes.get(key).cx, nodes.get(key).cy]]))));
      } catch (e) { /* storage may be blocked; the layout just won't be remembered */ }
    };
    const resetLayout = () => {
      movedNodes.clear();
      nodes.forEach((node, key) => place(key, node.startCx, node.startCy));
      edges.forEach((edge) => {
        edge.path.setAttribute('d', edge.d);
        if (edge.label) {
          edge.label.setAttribute('x', edge.lx);
          edge.label.setAttribute('y', edge.ly);
        }
      });
      saveLayout();
    };
    try {
      const saved = JSON.parse(localStorage.getItem(layoutKey) || '{}');
      for (const [key, position] of Object.entries(saved)) {
        if (nodes.has(key) && Array.isArray(position) && position.every(Number.isFinite)) {
          movedNodes.add(key);
          place(key, position[0], position[1]);
        }
      }
      resetButton.hidden = movedNodes.size === 0;
    } catch (e) { /* unreadable saved layout: use the default one */ }
    const bounds = () => {
      if (!movedNodes.size) return { minX: 0, minY: 0, w: width, h: height };
      const all = [...nodes.values()];
      const minX = Math.min(...all.map((n) => n.cx - nodeW / 2));
      const minY = Math.min(...all.map((n) => n.cy - nodeH / 2));
      return { minX, minY, w: Math.max(...all.map((n) => n.cx + nodeW / 2)) - minX, h: Math.max(...all.map((n) => n.cy + nodeH / 2)) - minY };
    };

    const fit = () => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const { minX, minY, w, h } = bounds();
      const whole = Math.min(box.width / (w + 40), box.height / (h + 40), 1.1);
      // Keep long graphs legible: start readable at the left edge and let people pan.
      const k = Math.max(whole, 0.55);
      view = { k, x: (w * k > box.width ? 16 : (box.width - w * k) / 2) - minX * k, y: (h * k > box.height ? 16 : (box.height - h * k) / 2) - minY * k };
      apply();
    };
    const zoom = (factor, cx, cy) => {
      const k = Math.min(3, Math.max(0.08, view.k * factor));
      view.x = cx - (cx - view.x) * (k / view.k);
      view.y = cy - (cy - view.y) * (k / view.k);
      view.k = k;
      apply();
    };
    fit();
    figure.dcCenterOn = (x, y) => {
      const box = svg.getBoundingClientRect();
      const k = Math.max(view.k, 0.8);
      svg.classList.add('dc-graph-moving');
      view = { k, x: box.width / 2 - x * k, y: box.height / 2 - y * k };
      apply();
      setTimeout(() => svg.classList.remove('dc-graph-moving'), 400);
    };
    figure.dcFit = fit;
    new ResizeObserver(() => { fit(); figure.dcAfterFit?.(); }).observe(svg);
    svg.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = svg.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - box.left, e.clientY - box.top);
    }, { passive: false });
    let drag = null;
    let moved = false;
    let nodeDrag = null;
    svg.addEventListener('pointerdown', (e) => {
      moved = false;
      const el = e.target.closest('.dc-node');
      if (el && e.button === 0) {
        const node = nodes.get(el.dataset.node);
        nodeDrag = { key: el.dataset.node, x: e.clientX, y: e.clientY, cx: node.cx, cy: node.cy };
        return;
      }
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    });
    // The boxes are links, so the browser would otherwise start dragging the link itself.
    svg.addEventListener('dragstart', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => {
      if (nodeDrag) {
        if (!moved && Math.abs(e.clientX - nodeDrag.x) + Math.abs(e.clientY - nodeDrag.y) <= 4) return;
        moved = true;
        svg.classList.add('dc-dragging');
        place(nodeDrag.key, nodeDrag.cx + (e.clientX - nodeDrag.x) / view.k, nodeDrag.cy + (e.clientY - nodeDrag.y) / view.k);
        return;
      }
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) moved = true;
      view.x = drag.vx + e.clientX - drag.x;
      view.y = drag.vy + e.clientY - drag.y;
      if (moved) { svg.classList.add('dc-dragging'); apply(); }
    });
    const endDrag = () => {
      if (nodeDrag && moved) {
        movedNodes.add(nodeDrag.key);
        saveLayout();
      }
      nodeDrag = null;
      drag = null;
      svg.classList.remove('dc-dragging');
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // Keyboard alternative to dragging: Shift + arrow keys on a focused box.
    svg.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.key];
      const el = e.target.closest('.dc-node');
      if (!e.shiftKey || !step || !el) return;
      e.preventDefault();
      e.stopPropagation();
      const node = nodes.get(el.dataset.node);
      place(el.dataset.node, node.cx + step[0], node.cy + step[1]);
      movedNodes.add(el.dataset.node);
      saveLayout();
    });
    svg.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
    figure.querySelector('.dc-graph-toolbar').addEventListener('click', (e) => {
      const action = e.target.dataset?.graph;
      const box = svg.getBoundingClientRect();
      if (action === 'in') zoom(1.25, box.width / 2, box.height / 2);
      if (action === 'out') zoom(0.8, box.width / 2, box.height / 2);
      if (action === 'fit') {
        const { minX, minY, w, h } = bounds();
        const k = Math.min(box.width / (w + 40), box.height / (h + 40), 1.1);
        view = { k, x: (box.width - w * k) / 2 - minX * k, y: (box.height - h * k) / 2 - minY * k };
        apply();
      }
      if (action === 'reset') {
        resetLayout();
        fit();
        figure.dcAfterFit?.();
      }
      if (action === 'full') {
        if (document.fullscreenElement) document.exitFullscreen(); else figure.requestFullscreen?.();
      }
      if (action === 'download') {
        const clone = svg.cloneNode(true);
        const { minX, minY, w, h } = bounds();
        clone.setAttribute('viewBox', `${minX - 20} ${minY - 20} ${w + 40} ${h + 40}`);
        clone.querySelector('.dc-graph-world').removeAttribute('style');
        const style = '<style>.dc-node-box{fill:#fff}.dc-node-title{font:600 13px sans-serif;fill:#111}.dc-node-sub{font:11px sans-serif}.dc-edge{fill:none;stroke:#94a3b8;stroke-width:1.4}.dc-edge-label{font:10px sans-serif;fill:#64748b}.dc-arrow{fill:#94a3b8}</style>';
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([clone.outerHTML.replace('<defs>', `${style}<defs>`)], { type: 'image/svg+xml' }));
        link.download = 'architecture.svg';
        link.click();
        URL.revokeObjectURL(link.href);
      }
    });
    figure.querySelector('.dc-graph-search').addEventListener('input', (e) => {
      const needle = e.target.value.toLowerCase().trim();
      figure.querySelectorAll('.dc-node').forEach((node) => node.classList.toggle('dc-node-dim', Boolean(needle) && !node.dataset.name.includes(needle)));
    });
    document.addEventListener('fullscreenchange', () => setTimeout(fit, 50));
  });

  // Flow walkthroughs: one step at a time, following whichever branch is chosen.
  document.querySelectorAll('.dc-flow').forEach((section) => {
    const plan = new Map(JSON.parse(section.dataset.flowPlan).map((step) => [step.id, step]));
    const figure = section.querySelector('.dc-graph');
    const back = section.querySelector('.dc-flow-back');
    const restart = section.querySelector('.dc-flow-restart');
    const progress = section.querySelector('.dc-flow-progress');
    const nextArea = section.querySelector('.dc-flow-next');
    const intro = section.querySelector('.dc-flow-intro');
    const panels = [...section.querySelectorAll('[data-step-panel]')];
    const key = (id) => `step:${id}`;
    const path = [];

    const center = (id) => {
      const node = [...figure.querySelectorAll('.dc-node')].find((n) => n.dataset.node === key(id));
      if (node) figure.dcCenterOn(Number(node.dataset.cx), Number(node.dataset.cy));
    };
    const nextButton = (target, text, primary) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `dc-btn${primary ? ' dc-btn-primary' : ''}`;
      button.dataset.flowGo = target;
      button.textContent = text;
      return button;
    };
    const render = (moveFocus) => {
      const current = path[path.length - 1];
      section.toggleAttribute('data-walking', Boolean(current));
      back.disabled = path.length === 0;
      restart.hidden = path.length === 0;
      intro.hidden = Boolean(current);
      panels.forEach((panel) => { panel.hidden = panel.dataset.stepPanel !== current; });
      const visited = new Set(path.map(key));
      const links = new Set(path.slice(1).map((id, i) => `${key(path[i])}>${key(id)}`));
      const arrived = path.length > 1 ? `${key(path[path.length - 2])}>${key(current)}` : null;
      figure.querySelectorAll('.dc-node').forEach((node) => {
        node.classList.toggle('dc-node-current', Boolean(current) && node.dataset.node === key(current));
        node.classList.toggle('dc-node-visited', visited.has(node.dataset.node));
      });
      figure.querySelectorAll('.dc-edge-group').forEach((edge) => {
        const link = `${edge.dataset.from}>${edge.dataset.to}`;
        edge.classList.toggle('dc-edge-visited', links.has(link));
        edge.classList.toggle('dc-edge-active', link === arrived);
      });
      nextArea.replaceChildren();
      if (!current) {
        nextArea.append(nextButton(section.dataset.flowStart, 'Start', true));
        progress.textContent = `${plan.size} steps`;
        figure.dcFit();
        if (moveFocus) nextArea.querySelector('button').focus({ preventScroll: true });
        return;
      }
      const step = plan.get(current);
      progress.textContent = `Step ${path.length}: ${step.title}`;
      if (step.next.length > 1) {
        const prompt = document.createElement('p');
        prompt.className = 'muted';
        prompt.textContent = 'This flow branches. Choose a path:';
        nextArea.append(prompt);
      }
      step.next.forEach((target) => {
        const title = plan.get(target.id).title;
        const text = target.label ? `${target.label}: ${title}` : title;
        nextArea.append(nextButton(target.id, step.next.length === 1 ? `Next: ${text}` : text, step.next.length === 1));
      });
      if (!step.next.length) {
        const end = document.createElement('p');
        end.className = 'muted';
        end.textContent = 'End of this path.';
        nextArea.append(end);
      }
      center(current);
      // The end of a path has no Next button, so focus moves to Restart rather than being lost.
      if (moveFocus) (nextArea.querySelector('button') || restart).focus({ preventScroll: true });
    };

    nextArea.addEventListener('click', (e) => {
      const target = e.target.closest('[data-flow-go]');
      if (!target) return;
      path.push(target.dataset.flowGo);
      render(true);
    });
    back.addEventListener('click', () => {
      path.pop();
      render(true);
    });
    restart.addEventListener('click', () => {
      path.length = 0;
      render(true);
    });
    section.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowLeft' && path.length) {
        e.preventDefault();
        path.pop();
        render(true);
      } else if (e.key === 'ArrowRight') {
        // Only moves when there's one way forward, since a branch needs a real choice.
        const options = nextArea.querySelectorAll('[data-flow-go]');
        if (options.length === 1) {
          e.preventDefault();
          options[0].click();
        }
      }
    });
    figure.dcAfterFit = () => {
      if (path.length) center(path[path.length - 1]);
    };
  });

  // Mermaid loads only on pages that use it.
  let mermaidLoaded = false;
  function renderMermaid(rerender) {
    const blocks = document.querySelectorAll('pre.mermaid');
    if (!blocks.length) return;
    const run = () => {
      const dark = root.dataset.color ? root.dataset.color === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' });
      blocks.forEach((b) => {
        if (b.dataset.source === undefined) b.dataset.source = b.textContent;
        else if (rerender) { b.removeAttribute('data-processed'); b.textContent = b.dataset.source; }
      });
      window.mermaid.run({ nodes: blocks }).catch((error) => console.error('Mermaid failed', error));
    };
    if (mermaidLoaded) return run();
    const script = document.createElement('script');
    script.src = `${base}_dc/mermaid.min.js`;
    script.onload = () => { mermaidLoaded = true; run(); };
    document.head.appendChild(script);
  }
  renderMermaid(false);

  // Live reload during development
  if (document.body.dataset.dev) {
    // Short checks, not an open connection, so any number of tabs can stay open.
    let known = null;
    const check = async () => {
      let delay = 1000;
      if (!document.hidden) {
        try {
          const version = await (await fetch('/__reload', { cache: 'no-store' })).text();
          if (known !== null && version !== known) location.reload();
          known = version;
        } catch (e) {
          delay = 5000; // The dev server is stopped; check less often until it returns.
        }
      }
      setTimeout(check, delay);
    };
    check();
  }
})();
