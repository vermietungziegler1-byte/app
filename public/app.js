(function () {
  const KEY = 'vermietung:data';
  // Alte Speicherplaetze aus frueheren Versionen, neueste zuerst.
  const ALT_KEYS = ['vermietung:v8', 'vermietung:v7', 'vermietung:v6', 'vermietung:v5',
    'vermietung:v4', 'vermietung:v3', 'vermietung:v2', 'vermietung:v1'];
  const root = document.getElementById('app');
  const D = 'https://drive.google.com/file/d/';

  function u(o) {
    return Object.assign({
      id: uid(), name: '', type: 'Wohnung', tenant: '', contact: '', movein: '',
      status: 'unbekannt', area: null, rent: null, nk: null, parking: null,
      kitchen: null, deposit: null, lastIncrease: '', note: '', hint: '', docs: [],
      zaehler: '', kwhStart: null, kwhEnde: null, abschlagStrom: null, monateStrom: 12,
      zahlungen: {}
    }, o || {});
  }
  function uid() { return 'u' + Math.random().toString(36).slice(2, 9); }
  function doc(name, id) { return { name: name, url: D + id + '/view' }; }

  const SEED = {
    objects: [
      {
        id: 'o1', name: 'Bertha-von-Suttner-Weg 4, 71334 Waiblingen',
        mietspiegel: 'Qualifizierter Mietspiegel Waiblingen/Korb 2025, 2. Auflage',
        mietspiegelUrl: 'https://www.waiblingen.de/de/Das-Rathaus/Buergerservice/Bauen-Wohnen/Mietspiegel',
        mietspiegelBis: '2027-01-31', note: '',
        units: [
          u({ name: 'EG Links' }), u({ name: 'EG Mitte' }), u({ name: 'EG Rechts' }),
          u({ name: '1.OG Links' }), u({ name: '1.OG Mitte' }), u({ name: '1.OG Rechts' }),
          u({ name: '2.OG Links' }), u({ name: '2.OG Mitte' }), u({ name: '2.OG Rechts' }),
          u({ name: 'Penthouse Links' }), u({ name: 'Penthouse Rechts' })
        ]
      },
      {
        id: 'o2', name: 'Dahlienweg 7, Waiblingen',
        mietspiegel: 'Qualifizierter Mietspiegel Waiblingen/Korb 2025, 2. Auflage',
        mietspiegelUrl: 'https://www.waiblingen.de/de/Das-Rathaus/Buergerservice/Bauen-Wohnen/Mietspiegel',
        mietspiegelBis: '2027-01-31', note: '',
        units: [
          u({ name: 'UG Wohnung' }), u({ name: 'EG Wohnung' }), u({ name: 'OG Wohnung' }),
          u({ name: 'DG Wohnung' }), u({ name: 'Garagenstellplatz', type: 'Garage' }),
          u({ name: 'Stellplatz 1', type: 'Stellplatz' }), u({ name: 'Stellplatz 2', type: 'Stellplatz' }),
          u({ name: 'Stellplatz 3', type: 'Stellplatz' }), u({ name: 'Stellplatz 4', type: 'Stellplatz' })
        ]
      },
      {
        id: 'o3', name: 'Tribergle 22, 71409 Schwaikheim',
        mietspiegel: 'Schwaikheim hat keinen eigenen qualifizierten Mietspiegel — die Gemeinde verweist auf den Mietspiegel der Stadt Winnenden',
        mietspiegelUrl: 'https://www.schwaikheim.de/Bauen-Wohnen/Mietspiegel', note: '',
        units: [u({ name: 'UG Wohnung' }), u({ name: 'EG Wohnung' }), u({ name: 'DG Wohnung' })]
      },
      {
        id: 'o4', name: 'Heinkelstraße 7, Berglen',
        mietspiegel: 'Berglen führt keinen eigenen Mietspiegel — die Gemeinde verweist auf den Mietspiegel der Stadt Winnenden',
        mietspiegelUrl: 'https://www.berglen.de/index.php?id=355', note: '',
        units: [
          u({ name: 'Einheit 1', type: 'Gewerbe' }), u({ name: 'Einheit 2' }),
          u({ name: 'Einheit 3', type: 'Gewerbe' }), u({ name: 'Einheit 4' }),
          u({ name: 'Einheit 5', type: 'Gewerbe' })
        ]
      },
      { id: 'o5', name: 'Holzgasse 23', note: '', units: [] },
      { id: 'o6', name: 'Pfarrer-Münch-Straße', note: '', units: [] },
      { id: 'o7', name: 'Maybachstraße', note: '', units: [] }
    ]
  };

  let data = null, open = {}, query = '', modal = null, toastTimer = null;
  let reiter = {};   // Objekt-ID -> 'einheiten' | 'zahlen' | 'aufgaben'
  let mobil = window.matchMedia('(max-width: 620px)').matches;
  let menueOffen = false;
  let seiteOffen = false;
  let fabOffen = false;
  let zuletztOffen = false;
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K') && phase === 'app') {
      ev.preventDefault();
      if (modal && modal.kind === 'suche') { const f = root.querySelector('#suche-q'); if (f) f.select(); }
      else if (!modal) sucheOeffnen();
      return;
    }
    if (modal || phase !== 'app') return;
    const imFeld = ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(ev.target.tagName) !== -1;
    if (ev.key === '/' && !imFeld) {
      ev.preventDefault();
      const q = root.querySelector('#q');
      if (q) q.focus(); else sucheOeffnen();
    }
    if (ev.key === 'q' && !imFeld && !ev.ctrlKey && !ev.metaKey && !ev.altKey && todoist.verbunden) {
      ev.preventDefault(); tdSchnell();
    }
    if (ev.key === 'Escape' && !imFeld && (tdMenue || tdEditor)) {
      tdMenue = null; tdEditor = null; render();
    }
    if (ev.key === 'Escape' && imFeld && ev.target.id === 'q') {
      query = ''; render();
    }
  });
  // Ein Klick irgendwo daneben schließt ein offenes Ausklappmenü
  document.addEventListener('click', function (ev) {
    if (!tdMenue) return;
    const t = ev.target;
    if (t && t.closest && (t.closest('.td-menue') || t.closest('[data-act="td-menue"]'))) return;
    tdMenue = null; render();
  });

  window.addEventListener('popstate', function () {
    if (modal) { modal = null; render(); }
  });

  // Nach unten wischen schließt das Fenster
  function wischen(bd) {
    const m = bd.querySelector('.modal');
    let start = null, weg = 0;
    m.addEventListener('touchstart', function (ev) {
      const inhalt = bd.querySelector('.fensterinhalt');
      if (inhalt && inhalt.scrollTop > 4) return;      // erst wenn oben angekommen
      start = ev.touches[0].clientY; weg = 0;
    }, { passive: true });
    m.addEventListener('touchmove', function (ev) {
      if (start === null) return;
      weg = ev.touches[0].clientY - start;
      if (weg > 0) m.style.transform = 'translateY(' + weg + 'px)';
    }, { passive: true });
    m.addEventListener('touchend', function () {
      if (start === null) return;
      m.style.transform = '';
      if (weg > 110) fensterZu();
      start = null;
    });
  }
  window.addEventListener('resize', function () {
    const jetzt = window.matchMedia('(max-width: 620px)').matches;
    if (jetzt !== mobil) { mobil = jetzt; if (data) render(); }
    else if (!mobil) { const m = root.querySelector('.backdrop .modal'); if (m) fensterAnwenden(m); }
  });

  // ---- Tafeln am PC: Größe ziehen, Reihenfolge tauschen, merken ----
  // Jede Tafel (Karte, Kennzahl-Kachel, Heute-Spalte) bekommt beim Überfahren
  // einen Griff oben (zum Tauschen) und eine Ecke unten rechts (zum Ziehen).
  // Gemerkt wird je Seite und Tafel: Breite in Prozent, Höhe in Pixel, Reihenfolge.
  const TAFEL_MASSE = 'vermietung:tafeln';
  const TAFEL_LUFT = 14;                                     // Abstand zwischen Tafeln
  const TAFEL_WAHL = '.tafel, .kpi, .heute-links, .heute-rechts';
  let tafelMasse = {};
  try { tafelMasse = JSON.parse(window.localStorage.getItem(TAFEL_MASSE) || '{}') || {}; } catch (e) { tafelMasse = {}; }
  function tafelSpeichern() {
    try { window.localStorage.setItem(TAFEL_MASSE, JSON.stringify(tafelMasse)); } catch (e) { /* egal */ }
  }

  // Stabiler Name einer Tafel, damit sie nach dem Neuaufbau wiedererkannt wird
  function tafelSchluessel(el, i) {
    if (el.dataset.tafel) return el.dataset.tafel;
    if (el.classList.contains('heute-links') || el.classList.contains('memo')) return 'memo';
    if (el.classList.contains('heute-rechts') || el.querySelector(':scope > .kalkopf')) return 'kalender';
    const kopf = el.querySelector(':scope > .label, :scope > h3, :scope > .kalkopf > h3, :scope > .memokopf');
    let s = kopf ? kopf.textContent : '';
    s = s.replace(/[0-9.,€%–—·:()]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
    return s || ('nr' + i);
  }

  // Alle Tafel-Gruppen der Seite: je ein Behälter, dessen Kinder alle Tafeln sind
  function tafelGruppen() {
    const alle = Array.from(root.querySelectorAll(TAFEL_WAHL)).filter(function (el) {
      if (el.closest('.modal')) return false;
      if (el.classList.contains('tafel') && el.parentNode.matches('.heute-links, .heute-rechts')) return false;
      return true;
    });
    const gruppen = [];
    alle.forEach(function (el) {
      const eltern = el.parentNode;
      const kinder = Array.from(eltern.children);
      const alleTafeln = kinder.every(function (k) { return k.matches(TAFEL_WAHL) || k.classList.contains('tf-reset-zeile'); });
      let beh;
      if (alleTafeln) beh = eltern;
      else {
        // gemischter Elternknoten: zusammenhängende Tafeln in eine eigene Hülle stecken
        if (eltern.classList.contains('tf-gruppe')) beh = eltern;
        else {
          const vorher = el.previousElementSibling;
          if (vorher && vorher.classList.contains('tf-gruppe')) { beh = vorher; beh.appendChild(el); }
          else { beh = document.createElement('div'); beh.className = 'tf-gruppe'; eltern.insertBefore(beh, el); beh.appendChild(el); }
        }
      }
      let g = gruppen.find(function (x) { return x.el === beh; });
      if (!g) { g = { el: beh, tafeln: [] }; gruppen.push(g); }
      g.tafeln.push(el);
    });
    gruppen.forEach(function (g, i) {
      g.id = ansicht + '/' + i + '/' + ((g.el.className || 'g').split(/\s+/)[0]);
      g.tafeln.forEach(function (el, j) { el.dataset.tfKey = tafelSchluessel(el, j); });
    });
    return gruppen;
  }

  // Behälter auf freies Fließen umstellen; Tafeln ohne gemerkte Breite behalten die gemessene
  function tafelFreiMachen(g) {
    if (g.el.classList.contains('tafeln-frei')) return;
    const W = g.el.clientWidth + TAFEL_LUFT;
    const messung = g.tafeln.map(function (el) {
      const r = el.getBoundingClientRect();
      return { el: el, p: (r.width + TAFEL_LUFT) / W * 100, oben: Math.round(r.top) };
    });
    // Zeilen, die voll waren, exakt auf 100 % bringen, sonst bricht die letzte Tafel um
    const zeilen = {};
    messung.forEach(function (m) { (zeilen[m.oben] = zeilen[m.oben] || []).push(m); });
    Object.keys(zeilen).forEach(function (k) {
      const z = zeilen[k], summe = z.reduce(function (a, m) { return a + m.p; }, 0);
      if (summe > 95) z.forEach(function (m) { m.p = m.p * 99.9 / summe; });
    });
    g.el.classList.add('tafeln-frei');
    messung.forEach(function (m) { m.el.style.width = 'calc(' + m.p.toFixed(2) + '% - ' + TAFEL_LUFT + 'px)'; });
  }

  function tafelMasseSetzen(g, el, aenderung) {
    const d = tafelMasse[g.id] = tafelMasse[g.id] || { masse: {} };
    const m = d.masse[el.dataset.tfKey] = d.masse[el.dataset.tfKey] || {};
    Object.assign(m, aenderung);
    el.classList.add('tf-eigen');
    tafelSpeichern();
  }
  function tafelReiheMerken(g) {
    const d = tafelMasse[g.id] = tafelMasse[g.id] || { masse: {} };
    d.reihe = Array.from(g.el.children).filter(function (k) { return k.dataset.tfKey; }).map(function (k) { return k.dataset.tfKey; });
    tafelSpeichern();
  }
  function tafelnZuruecksetzen(nurGruppe, nurKey) {
    Object.keys(tafelMasse).forEach(function (gid) {
      if (gid.indexOf(ansicht + '/') !== 0) return;
      if (nurGruppe && gid !== nurGruppe) return;
      if (nurKey) {
        const d = tafelMasse[gid];
        delete d.masse[nurKey];
        if (d.reihe) d.reihe = d.reihe.filter(function (k) { return k !== nurKey; });
        if (!Object.keys(d.masse).length && !(d.reihe && d.reihe.length)) delete tafelMasse[gid];
      } else delete tafelMasse[gid];
    });
    tafelSpeichern();
    render();
  }

  function tafelnRahmen() {
    const gruppen = tafelGruppen();
    let irgendwas = false;
    gruppen.forEach(function (g) {
      const d = tafelMasse[g.id];
      g.tafeln.forEach(function (el) { el.classList.add('tf-tafel'); });
      if (d) {
        irgendwas = true;
        tafelFreiMachen(g);
        // gemerkte Reihenfolge
        if (d.reihe && d.reihe.length) {
          const rest = g.tafeln.filter(function (el) { return d.reihe.indexOf(el.dataset.tfKey) === -1; });
          d.reihe.forEach(function (k) {
            const el = g.tafeln.find(function (x) { return x.dataset.tfKey === k; });
            if (el) g.el.appendChild(el);
          });
          rest.forEach(function (el) { g.el.appendChild(el); });
        }
        // gemerkte Maße
        g.tafeln.forEach(function (el) {
          const m = d.masse[el.dataset.tfKey];
          if (!m) return;
          el.classList.add('tf-eigen');
          if (m.p) el.style.width = 'calc(' + Math.min(99.9, Math.max(8, m.p)).toFixed(2) + '% - ' + TAFEL_LUFT + 'px)';
          if (m.h) { el.style.height = Math.max(60, m.h) + 'px'; el.classList.add('tf-hoch'); }
        });
      }
      g.tafeln.forEach(function (el) { tafelGriffe(g, el); });
    });
    if (irgendwas) {
      const zeile = document.createElement('div');
      zeile.className = 'tf-reset-zeile';
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '↺ Tafeln dieser Seite zurücksetzen';
      b.addEventListener('click', function () { tafelnZuruecksetzen(); });
      zeile.appendChild(b);
      const letzte = gruppen[gruppen.length - 1].el;
      letzte.parentNode.insertBefore(zeile, letzte.nextSibling);
    }
  }

  function tafelGriffe(g, el) {
    if (el.querySelector(':scope > .tf-griff')) return;
    const griff = document.createElement('div');
    griff.className = 'tf-griff';
    griff.innerHTML = '<button type="button" class="tf-zieh" title="Anfassen und an eine andere Stelle ziehen">⋮⋮</button>'
      + '<button type="button" class="tf-rueck" title="Diese Tafel auf Standard zurücksetzen">↺</button>';
    const eck = document.createElement('div'); eck.className = 'tf-eck'; eck.title = 'Größe ziehen';
    const kr = document.createElement('div'); kr.className = 'tf-kante-r';
    const ku = document.createElement('div'); ku.className = 'tf-kante-u';
    el.appendChild(griff); el.appendChild(kr); el.appendChild(ku); el.appendChild(eck);

    griff.querySelector('.tf-rueck').addEventListener('click', function (ev) {
      ev.stopPropagation(); tafelnZuruecksetzen(g.id, el.dataset.tfKey);
    });

    // Größe ziehen
    function ziehen(h, breite, hoehe) {
      h.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        ev.preventDefault(); ev.stopPropagation();
        tafelFreiMachen(g);
        const r = el.getBoundingClientRect();
        const startX = ev.clientX, startY = ev.clientY, w0 = r.width, h0 = r.height;
        let maxB = g.el.clientWidth - TAFEL_LUFT;
        // Der rechte Nachbar in derselben Zeile gibt ab, was diese Tafel dazubekommt (wie ein Teiler)
        let nachbar = null, nW0 = 0;
        if (breite) {
          const n = el.nextElementSibling;
          if (n && n.dataset.tfKey) {
            const nr = n.getBoundingClientRect();
            if (Math.round(nr.top) === Math.round(r.top)) { nachbar = n; nW0 = nr.width; maxB = w0 + nW0 - 120; }
          }
        }
        let w = w0, hh = h0;
        el.style.width = w0 + 'px';
        if (nachbar) nachbar.style.width = nW0 + 'px';
        if (hoehe) { el.style.height = h0 + 'px'; el.classList.add('tf-hoch'); }
        h.setPointerCapture(ev.pointerId);
        function bewegen(e) {
          if (breite) {
            w = fensterGrenze(w0 + (e.clientX - startX), 120, maxB); el.style.width = w + 'px';
            if (nachbar) nachbar.style.width = (nW0 + w0 - w) + 'px';
          }
          if (hoehe) { hh = fensterGrenze(h0 + (e.clientY - startY), 60, 2400); el.style.height = hh + 'px'; }
        }
        function prozent(px) { return Math.round((px + TAFEL_LUFT) / g.el.clientWidth * 1000) / 10; }
        function fertig() {
          h.removeEventListener('pointermove', bewegen);
          h.removeEventListener('pointerup', fertig);
          h.removeEventListener('pointercancel', fertig);
          const neu = {};
          if (breite) neu.p = prozent(w);
          if (hoehe) neu.h = Math.round(hh);
          tafelMasseSetzen(g, el, neu);
          if (breite) el.style.width = 'calc(' + neu.p.toFixed(2) + '% - ' + TAFEL_LUFT + 'px)';
          if (nachbar) {
            const np = prozent(nW0 + w0 - w);
            tafelMasseSetzen(g, nachbar, { p: np });
            nachbar.style.width = 'calc(' + np.toFixed(2) + '% - ' + TAFEL_LUFT + 'px)';
          }
        }
        h.addEventListener('pointermove', bewegen);
        h.addEventListener('pointerup', fertig);
        h.addEventListener('pointercancel', fertig);
      });
    }
    ziehen(eck, true, true); ziehen(kr, true, false); ziehen(ku, false, true);

    // Reihenfolge tauschen: am Griff anfassen, über eine andere Tafel ziehen, loslassen
    const zieh = griff.querySelector('.tf-zieh');
    zieh.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      tafelFreiMachen(g);
      zieh.setPointerCapture(ev.pointerId);
      el.classList.add('tf-zieht'); griff.classList.add('aktiv');
      let ziel = null, vor = false, bewegt = false;
      function markiere(z, v) {
        if (ziel && (ziel !== z || vor !== v)) ziel.classList.remove('tf-ziel-vor', 'tf-ziel-nach');
        ziel = z; vor = v;
        if (ziel) ziel.classList.add(vor ? 'tf-ziel-vor' : 'tf-ziel-nach');
      }
      function bewegen(e) {
        bewegt = true;
        const unter = document.elementFromPoint(e.clientX, e.clientY);
        const z = unter && unter.closest ? unter.closest('.tf-tafel') : null;
        if (!z || z === el || z.parentNode !== g.el) { markiere(null, false); return; }
        const r = z.getBoundingClientRect();
        markiere(z, e.clientX < r.left + r.width / 2);
      }
      function fertig() {
        zieh.removeEventListener('pointermove', bewegen);
        zieh.removeEventListener('pointerup', fertig);
        zieh.removeEventListener('pointercancel', fertig);
        el.classList.remove('tf-zieht'); griff.classList.remove('aktiv');
        if (ziel) {
          const z = ziel, davor = vor; markiere(null, false);
          if (davor) g.el.insertBefore(el, z); else g.el.insertBefore(el, z.nextSibling);
          tafelReiheMerken(g);
          render();
        } else if (bewegt) {
          tafelReiheMerken(g);
        }
      }
      zieh.addEventListener('pointermove', bewegen);
      zieh.addEventListener('pointerup', fertig);
      zieh.addEventListener('pointercancel', fertig);
    });
  }

  // ---- Fenster am PC: Größe ziehen, verschieben, merken ----
  // Je Fensterart (Aufgabe, Objekt, Stromabrechnung …) merkt sich der Browser
  // Breite/Höhe und – falls verschoben – die Lage. Gespeichert wird nur, was
  // wirklich gezogen wurde: Breite allein lässt die Höhe weiter automatisch.
  const FENSTER_MASSE = 'vermietung:fenster';
  let fensterMasse = {};
  try { fensterMasse = JSON.parse(window.localStorage.getItem(FENSTER_MASSE) || '{}') || {}; } catch (e) { fensterMasse = {}; }
  function fensterMasseSpeichern() {
    try { window.localStorage.setItem(FENSTER_MASSE, JSON.stringify(fensterMasse)); } catch (e) { /* egal */ }
  }
  function fensterGrenze(wert, von, bis) { return Math.max(von, Math.min(bis, wert)); }

  // Gemerkte Maße auf das offene Fenster legen (und in den Bildschirm einpassen)
  function fensterAnwenden(m) {
    const art = m.getAttribute('data-fenster');
    const g = fensterMasse[art];
    const bd = m.parentNode;
    const rand = 16;
    m.classList.remove('fx-eigen', 'fx-frei');
    m.style.width = ''; m.style.height = ''; m.style.left = ''; m.style.top = '';
    if (!g) return;
    const maxB = bd.clientWidth - rand * 2, maxH = bd.clientHeight - rand * 2;
    m.classList.add('fx-eigen');
    if (g.w) m.style.width = fensterGrenze(g.w, 360, maxB) + 'px';
    if (g.h) m.style.height = fensterGrenze(g.h, 200, maxH) + 'px';
    if (g.x !== undefined && g.y !== undefined) {
      m.classList.add('fx-frei');
      const r = m.getBoundingClientRect();
      m.style.left = fensterGrenze(g.x, rand, Math.max(rand, bd.clientWidth - r.width - rand)) + 'px';
      m.style.top = fensterGrenze(g.y, rand, Math.max(rand, bd.clientHeight - r.height - rand)) + 'px';
    }
  }

  function fensterZuruecksetzen() {
    const m = root.querySelector('.backdrop .modal');
    if (!m) return;
    delete fensterMasse[m.getAttribute('data-fenster')];
    fensterMasseSpeichern();
    fensterAnwenden(m);
  }

  function fensterRahmen(bd) {
    const m = bd.querySelector('.modal');
    if (!m) return;
    const art = m.getAttribute('data-fenster');
    fensterAnwenden(m);

    // Ziehen an Ecke / rechter Kante / unterer Kante
    function ziehen(el, breite, hoehe) {
      el.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        ev.preventDefault(); ev.stopPropagation();
        const r = m.getBoundingClientRect(), bdr = bd.getBoundingClientRect();
        const startX = ev.clientX, startY = ev.clientY, w0 = r.width, h0 = r.height;
        const maxB = bd.clientWidth - 32, maxH = bd.clientHeight - 32;
        // Sobald gezogen wird, bleibt die linke obere Ecke stehen
        m.classList.add('fx-eigen', 'fx-frei', 'fx-zieht');
        m.style.left = (r.left - bdr.left) + 'px'; m.style.top = (r.top - bdr.top) + 'px';
        m.style.width = w0 + 'px'; m.style.height = h0 + 'px';
        el.setPointerCapture(ev.pointerId);
        let w = w0, h = h0;
        function bewegen(e) {
          if (breite) { w = fensterGrenze(w0 + (e.clientX - startX), 360, Math.max(360, maxB - (r.left - bdr.left) + 16)); m.style.width = w + 'px'; }
          if (hoehe) { h = fensterGrenze(h0 + (e.clientY - startY), 200, Math.max(200, maxH - (r.top - bdr.top) + 16)); m.style.height = h + 'px'; }
        }
        function fertig() {
          el.removeEventListener('pointermove', bewegen);
          el.removeEventListener('pointerup', fertig);
          el.removeEventListener('pointercancel', fertig);
          m.classList.remove('fx-zieht');
          const g = fensterMasse[art] || {};
          if (breite) g.w = Math.round(w);
          if (hoehe) g.h = Math.round(h);
          const rr = m.getBoundingClientRect();
          g.x = Math.round(rr.left - bdr.left); g.y = Math.round(rr.top - bdr.top);
          fensterMasse[art] = g;
          fensterMasseSpeichern();
        }
        el.addEventListener('pointermove', bewegen);
        el.addEventListener('pointerup', fertig);
        el.addEventListener('pointercancel', fertig);
      });
    }
    ziehen(m.querySelector('.fx-eck'), true, true);
    ziehen(m.querySelector('.fx-kante-r'), true, false);
    ziehen(m.querySelector('.fx-kante-u'), false, true);

    // Verschieben an der Leiste
    const leiste = m.querySelector('.fx-leiste');
    if (leiste) leiste.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || ev.target.closest('button')) return;
      ev.preventDefault();
      const r = m.getBoundingClientRect(), bdr = bd.getBoundingClientRect();
      const startX = ev.clientX, startY = ev.clientY, x0 = r.left - bdr.left, y0 = r.top - bdr.top;
      const maxX = Math.max(0, bd.clientWidth - r.width), maxY = Math.max(0, bd.clientHeight - r.height);
      let x = x0, y = y0, bewegt = false;
      leiste.setPointerCapture(ev.pointerId);
      function bewegen(e) {
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!bewegt && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        if (!bewegt) {
          bewegt = true;
          m.classList.add('fx-eigen', 'fx-frei', 'fx-zieht'); leiste.classList.add('zieht');
          m.style.width = r.width + 'px'; m.style.height = r.height + 'px';
        }
        x = fensterGrenze(x0 + dx, 0, maxX); y = fensterGrenze(y0 + dy, 0, maxY);
        m.style.left = x + 'px'; m.style.top = y + 'px';
      }
      function fertig() {
        leiste.removeEventListener('pointermove', bewegen);
        leiste.removeEventListener('pointerup', fertig);
        leiste.removeEventListener('pointercancel', fertig);
        m.classList.remove('fx-zieht'); leiste.classList.remove('zieht');
        if (!bewegt) return;
        const g = fensterMasse[art] || {};
        g.x = Math.round(x); g.y = Math.round(y);
        if (!g.w) g.w = Math.round(r.width);
        if (!g.h) g.h = Math.round(r.height);
        fensterMasse[art] = g;
        fensterMasseSpeichern();
      }
      leiste.addEventListener('pointermove', bewegen);
      leiste.addEventListener('pointerup', fertig);
      leiste.addEventListener('pointercancel', fertig);
    });
  }
  let theme = 'dark';
  let themeWahl = 'auto';   // auto = wie das Gerät | light | dark
  const geraetDunkel = window.matchMedia('(prefers-color-scheme: dark)');
  function themeAnwenden() {
    theme = themeWahl === 'auto' ? (geraetDunkel.matches ? 'dark' : 'light') : themeWahl;
    root.setAttribute('data-theme', theme);
    const dlg = document.getElementById('dialog');
    if (dlg) dlg.setAttribute('data-theme', theme);
  }
  geraetDunkel.addEventListener('change', function () { if (themeWahl === 'auto') themeAnwenden(); });
  let letzteSpeicher = [];
  let speicherFehler = false;   // letzte Änderung kam nicht beim Server an
  let sicherungInfo = null;     // Stand der Server- und Drive-Sicherung (nur Verwalter)
  let sicherungLaeuftJetzt = false;

  // Mitteilungen (Push) und Interessenten
  let swReg = null, pushAbo = null, pushGeraete = null, pushEinst = null, pushFehler = null;
  let absagenOffen = false;
  let mietVersatz = 0;   // 0 = laufender Monat, -1 = Vormonat …
  let ansicht = 'heute';   // heute | objekte | mieten | interessenten | post
  let verstecktOffen = false;
  let rg = null;             // Rechnungen: Absender, gespeicherte Liste, nächste Nummer (vom Server)
  let rgForm = null;         // Entwurf der Rechnung, die gerade bearbeitet wird
  let rgTab = 'as';          // as = Allgemeinstrom | pv = Solarstrom | nk = Nebenkosten-Schreiben
  let nkForm = null;         // Entwurf des Nebenkosten-Schreibens
  let rgFormOffen = false;   // Abrechnungen: Formular offen (sonst nur die Liste)
  let nkFormOffen = false;
  let alleAufgaben = null;   // alle offenen Todoist-Aufgaben - die eine Quelle für Heute, Objekte und Aufgaben

  let staende = [];   // alle gefundenen Speicherstaende

  function fuellung(d) {
    let felder = 0, einheiten = 0;
    (d && d.objects ? d.objects : []).forEach(function (o) {
      (o.units || []).forEach(function (x) {
        einheiten++;
        ['tenant', 'contact', 'movein', 'rent', 'nk', 'parking', 'kitchen', 'area',
         'deposit', 'lastIncrease', 'note'].forEach(function (k) {
          if (x[k] !== null && x[k] !== undefined && x[k] !== '') felder++;
        });
        felder += (x.docs || []).length;
      });
      if (o.benchmark) felder++;
    });
    return { felder: felder, einheiten: einheiten };
  }

  async function load() {
    try {
      const t = window.localStorage.getItem('vermietung:theme');
      if (t === 'light' || t === 'dark') themeWahl = t;
    } catch (e) { /* Voreinstellung */ }
    themeAnwenden();

    data = structuredClone(SEED);
    normalisieren();

    try {
      const st = await api('status');
      if (!st.eingerichtet) phase = 'einrichten';
      else if (!st.angemeldet) phase = 'anmelden';
      else {
        nutzerName = st.nutzer;
        nutzerRolle = st.rolle || 'nutzer';
        await datenHolen();
        await todoistLaden();
        await stimmeLaden();
        await assistentLaden();
        await wocheLaden();
        await googleLaden();
        await gkalStatusLaden();
        await postLaden();
        phase = 'app';
      }
    } catch (e) {
      phase = 'anmelden';
      toast('Server nicht erreichbar');
    }
    render();
    zuletztAufgefrischt = Date.now();
    if (phase === 'app' && todoist.verbunden) {
      planLaden().then(function () {
        if (planWunsch) { planWunsch = false; modal = { kind: 'plan' }; }
        render();
      });
    }
  }

  // Fehlende Felder ergaenzen, damit spaetere Erweiterungen nichts kaputt machen.
  function normalisieren() {
    if (!data || !Array.isArray(data.objects)) data = structuredClone(SEED);
    const vorlage = u({});
    data.objects.forEach(function (o) {
      if (!Array.isArray(o.units)) o.units = [];
      o.units.forEach(function (x) {
        Object.keys(vorlage).forEach(function (k) {
          if (!(k in x)) x[k] = k === 'docs' ? [] : vorlage[k];
        });
        if (!Array.isArray(x.docs)) x.docs = [];
      });
    });
    if (!Array.isArray(data.interessenten)) data.interessenten = [];
    const iVorlage = interessentNeu({});
    data.interessenten.forEach(function (i) {
      Object.keys(iVorlage).forEach(function (k) { if (!(k in i)) i[k] = iVorlage[k]; });
    });
  }

  // ---------------------------------------------------------------
  //  Speichern: erst die Datei, die du verbunden hast, dann der
  //  Browserspeicher, dann der Speicher innerhalb von Claude.
  // ---------------------------------------------------------------
  let dateiGriff = null;          // Verweis auf die verbundene Datei
  let dateiName = '';

  const LOKAL = 'vermietung:lokal';
  const SICHERUNG_ZEIT = 'vermietung:sicherung';

  // ---------------------------------------------------------------
  //  Alles läuft jetzt über deinen Server: Anmeldung, Daten, Verlauf.
  // ---------------------------------------------------------------
  let nutzerName = '';
  let nutzerRolle = 'nutzer';
  let phase = 'start';        // start | einrichten | anmelden | app
  let zuletztGeaendert = null;
  let gespeichertUm = 0;      // wann dieses Gerät zuletzt gespeichert hat (für den kurzen Hinweis unten)
  let speicherLaeuft = false;
  let nochmalSpeichern = false;

  // Dünner Ladebalken oben, solange Anfragen laufen, die länger als einen Augenblick dauern
  let laufend = 0, ladeUhr = null;
  function ladebalken(an) {
    let el = document.getElementById('ladebalken');
    if (!el) { el = document.createElement('div'); el.id = 'ladebalken'; document.body.appendChild(el); }
    el.classList.toggle('an', an);
  }
  function anfrageStart() {
    laufend++;
    if (laufend === 1) ladeUhr = setTimeout(function () { ladebalken(true); }, 350);
  }
  function anfrageEnde() {
    laufend = Math.max(0, laufend - 1);
    if (!laufend) { clearTimeout(ladeUhr); ladebalken(false); }
  }

  async function api(pfad, optionen) {
    anfrageStart();
    try { return await apiRoh(pfad, optionen); } finally { anfrageEnde(); }
  }
  async function apiRoh(pfad, optionen) {
    const o = Object.assign({ credentials: 'same-origin' }, optionen || {});
    if (o.body && typeof o.body !== 'string') {
      o.body = JSON.stringify(o.body);
      o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    }
    const antwort = await fetch('/api/' + pfad, o);
    let inhalt = null;
    try { inhalt = await antwort.json(); } catch (e) { inhalt = null; }
    if (!antwort.ok) {
      const fehler = new Error((inhalt && inhalt.fehler) || ('Fehler ' + antwort.status));
      fehler.status = antwort.status;
      fehler.inhalt = inhalt;
      throw fehler;
    }
    return inhalt;
  }

  async function zugangEinrichten(name, passwort) {
    try {
      await api('setup', { method: 'POST', body: { name: name, passwort: passwort } });
      nutzerName = name;
      nutzerRolle = 'verwalter';
      data = structuredClone(SEED);
      normalisieren();
      phase = 'app';
      await save('Zugang eingerichtet');
      render();
    } catch (e) { toast(e.message); }
  }

  async function anmelden(name, passwort) {
    try {
      const res = await api('login', { method: 'POST', body: { name: name, passwort: passwort } });
      nutzerName = res.nutzer;
      nutzerRolle = res.rolle || 'nutzer';
      await datenHolen();
      phase = 'app';
      render();
    } catch (e) { toast(e.message); }
  }

  async function datenHolen() {
    const res = await api('data');
    data = res.data || structuredClone(SEED);
    zuletztGeaendert = res.wann ? { wer: res.wer, wann: res.wann } : null;
    normalisieren();
    SEED.objects.forEach(function (v) {
      if (!data.objects.some(function (o) { return o.id === v.id; })) data.objects.push(structuredClone(v));
    });
  }

  async function abmelden() {
    try { await api('logout', { method: 'POST' }); } catch (e) { /* egal */ }
    nutzerName = ''; data = structuredClone(SEED); phase = 'anmelden';
    render();
  }

  async function nutzerAnlegen(name, passwort) {
    try {
      await api('users', { method: 'POST', body: { name: name, passwort: passwort } });
      toast('Zugang für ' + name + ' angelegt');
      await nutzerListeHolen();
      render();
    } catch (e) { toast(e.message); }
  }

  async function nutzerLoeschen(name) {
    try {
      await api('users/' + encodeURIComponent(name), { method: 'DELETE' });
      toast('Zugang entfernt');
      await nutzerListeHolen();
      render();
    } catch (e) { toast(e.message); }
  }

  let todoist = { verbunden: false, zuordnung: {} };
  let todoistProjekte = [];
  let aufgaben = {};        // Objekt-ID -> Liste offener Aufgaben
  let wocheListe = null;    // alles, was in den nächsten sieben Tagen ansteht
  let google = { eingerichtet: false, verbunden: false, adresse: null };
  let postListe = null;     // gefilterte Mails

  async function googleLaden() {
    try { google = await api('google'); } catch (e) { google = { eingerichtet: false, verbunden: false }; }
  }

  // --- Google Kalender: Termine aus der privaten iCal-Adresse ---
  let gkal = { eingerichtet: false };
  let gkalListe = [];          // die geladenen Termine
  let gkalBereich = '';        // schon geholter Zeitraum, damit nichts doppelt läuft
  let gkalFrisch = false;      // beim nächsten Laden den Zwischenspeicher umgehen

  async function gkalStatusLaden() {
    try { gkal = await api('gkal'); } catch (e) { gkal = { eingerichtet: false }; }
  }
  function gkalNachladen(von, bis) {
    if (!gkal.eingerichtet) return;
    const schluessel = von + '..' + bis;
    if (gkalBereich === schluessel && !gkalFrisch) return;
    gkalBereich = schluessel;
    const frisch = gkalFrisch; gkalFrisch = false;
    api('gkal/termine?von=' + von + '&bis=' + bis + (frisch ? '&frisch=1' : ''))
      .then(function (r) { gkalListe = (r && r.termine) || []; render(); })
      .catch(function () { /* Kalender gerade nicht erreichbar — der Rest läuft normal */ });
  }

  let postInfo = null;
  let postAlle = false;
  let postTage = 90;
  let postModus = 'streng';   // beim Laden nur die Treffer
  let postFilter = null;
  let postFrisch = false;

  async function postLaden() {
    if (!google.verbunden) { postListe = []; return; }
    try {
      const a = await api('post?tage=' + postTage + '&modus=' + postModus + (postFrisch ? '&frisch=1' : ''));
      postFrisch = false;
      postListe = a.mails || [];
      postInfo = { geprueft: a.geprueft, begriffe: a.suchbegriffe, rest: a.rest || [], versteckt: a.versteckt || [], tage: a.tage,
        neueste: a.neueste, ausCache: a.ausCache, geholt: a.geholt,
        postfach: a.postfach, gesamt: a.gesamt };
    } catch (e) { postListe = []; postInfo = { fehler: e.message }; }
  }

  // =================================================================
  // Aufgaben wie in Todoist
  // Eine Quelle für alles: die Übersicht aus /api/todoist/uebersicht.
  // Wochenliste und Objektlisten werden daraus abgeleitet.
  // =================================================================
  let tdProjekte = [];        // Todoist-Projekte mit Farbe
  let tdSektionen = [];       // Todoist-Abschnitte
  let tdAnsicht = 'heute';    // 'heute' | 'demnaechst' | 'alle' | 'wartet' | 'projekt:<id>'
  // Filter oben in der Aufgabenliste: Projekt (= Objekt) und Label, dazu „nach Objekt gruppieren“
  let tdFilter = { projekt: '', label: '' };
  let tdGruppiert = false;
  try { tdGruppiert = window.localStorage.getItem('vermietung:td-gruppiert') === '1'; } catch (e) { /* egal */ }
  // Wartet auf Antwort: das vorhandene Label nutzen, sonst dieses anlegen
  const WARTET_MUSTER = /wartet|warten|waiting/i;
  function tdWartet(t) { return (t.labels || []).some(function (l) { return WARTET_MUSTER.test(l); }); }
  function tdWartetLabel() {
    let gefunden = '';
    (alleAufgaben || []).some(function (t) {
      return (t.labels || []).some(function (l) { if (WARTET_MUSTER.test(l)) { gefunden = l; return true; } return false; });
    });
    return gefunden || 'Wartet-auf-Antwort';
  }
  let tdZu = {};              // eingeklappte Abschnitte und Aufgaben
  let tdEditor = null;        // offener Eingabekasten für eine neue Aufgabe
  let tdMenue = null;         // offenes Ausklappmenü { typ, tid }
  let tdSuche = '';
  let tdSucheFokus = false;
  try {
    const a = window.localStorage.getItem('vermietung:tdansicht'); if (a) tdAnsicht = a;
    const z = window.localStorage.getItem('vermietung:tdzu'); if (z) tdZu = JSON.parse(z) || {};
  } catch (e) { /* egal */ }
  function tdMerken() {
    try {
      window.localStorage.setItem('vermietung:tdansicht', tdAnsicht);
      window.localStorage.setItem('vermietung:tdzu', JSON.stringify(tdZu));
    } catch (e) { /* egal */ }
  }

  // Zeichen im Stil von Todoist (Linien, kein Füllfarbe)
  const TDI = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    kalender: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    demnaechst: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M7 14h4M7 17h4M13 14h4"/></svg>',
    weiter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M10.5 13.5l3 3-3 3"/></svg>',
    sonne: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    sofa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M2 13a2 2 0 0 1 4 0v3h12v-3a2 2 0 0 1 4 0v5H2z"/></svg>',
    alle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M4 14h4l2 3h4l2-3h4"/></svg>',
    unter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M8 12h12M12 18h8"/></svg>',
    kommentar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z"/></svg>',
    label: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    stift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    mehr: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    flagge: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18h2v-7h11.5l-3-4 3-4H7V3z"/></svg>',
    flaggeLeer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 4v17M6 4h12.5l-3 4 3 4H6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    kreisX: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>',
    wieder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    suche: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    frisch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>',
    ordner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    extern: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    muell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    fertigKreis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
    uhr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };
  // Kalenderblatt mit der Tageszahl, wie das "Heute"-Zeichen in Todoist
  function tdHeuteZeichen(tag) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'
      + '<text x="12" y="19.2" font-size="8.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Inter, sans-serif">' + tag + '</text></svg>';
  }

  // ---- Datum-Helfer (alles lokal, ohne Zeitzonenfallen) ----
  function tdHeute() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function tdTag(s) {
    if (!s) return null;
    const t = String(s).slice(0, 10).split('-');
    return new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2]));
  }
  function tdIso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function tdPlus(tage) { const d = tdHeute(); d.setDate(d.getDate() + tage); return d; }
  function tdNaechsteWoche() {   // nächster Montag
    const d = tdHeute(); const tag = (d.getDay() + 6) % 7; d.setDate(d.getDate() + (7 - tag)); return d;
  }
  function tdWochenende() {      // nächster Samstag, heute falls Samstag
    const d = tdHeute(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7)); return d;
  }
  function tdKurz(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function tdDatumLang(d) {
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }).replace(/\.$/, '');
  }
  function tdWochentag(d, kurz) { return d.toLocaleDateString('de-DE', { weekday: kurz ? 'short' : 'long' }).replace(/\.$/, ''); }

  // Datum in Worten und Farbe, wie Todoist es zeigt
  function tdWann(t) {
    if (!t.faellig) return null;
    const d = tdTag(t.faellig), heute0 = tdHeute();
    const diff = Math.round((d - heute0) / 86400000);
    let text, klasse;
    if (diff < 0) { text = diff === -1 ? 'Gestern' : tdDatumLang(d); klasse = 'spaet'; }
    else if (diff === 0) { text = 'Heute'; klasse = 'heute'; }
    else if (diff === 1) { text = 'Morgen'; klasse = 'morgen'; }
    else if (diff < 7) { text = tdWochentag(d, false); klasse = 'woche'; }
    else {
      text = tdDatumLang(d) + (d.getFullYear() !== heute0.getFullYear() ? ' ' + d.getFullYear() : '');
      klasse = 'spaeter';
    }
    if (t.faelligZeit) {
      const z = new Date(t.faelligZeit);
      if (!isNaN(z)) text += ' ' + z.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }
    return { text: text, klasse: klasse };
  }

  // ---- Zugriff auf die geladenen Aufgaben ----
  function tdFinde(id) { return (alleAufgaben || []).find(function (t) { return t.id === id; }) || null; }
  function tdKinder(id) {
    return (alleAufgaben || []).filter(function (t) { return t.eltern === id; }).sort(tdSortReihe);
  }
  function tdNachfahren(id) {
    let ids = [];
    tdKinder(id).forEach(function (k) { ids.push(k.id); ids = ids.concat(tdNachfahren(k.id)); });
    return ids;
  }
  function tdProjekt(pid) { return tdProjekte.find(function (p) { return p.id === pid; }) || null; }
  function tdProjektName(pid) {
    const p = tdProjekt(pid);
    if (p && p.eingang) return 'Eingang';
    return p ? p.name : '';
  }
  function tdProjektFarbe(pid) { const p = tdProjekt(pid); return p ? p.farbe : 'var(--muted)'; }
  // Projekte in der Reihenfolge der Seitenleiste: Eingang, dann zugeordnete Objekte, dann der Rest
  function tdProjektListe() {
    const liste = tdProjekte.slice();
    const rang = function (p) {
      if (p.eingang) return -1;
      const i = data.objects.findIndex(function (o) { return todoist.zuordnung && todoist.zuordnung[o.id] === p.id; });
      return i === -1 ? 1000 + (p.reihenfolge || 0) : i;
    };
    liste.sort(function (a, c) { return rang(a) - rang(c) || (a.reihenfolge || 0) - (c.reihenfolge || 0); });
    return liste;
  }
  function tdStandardProjekt() {
    if (tdAnsicht.indexOf('projekt:') === 0) return tdAnsicht.slice(8);
    const o = data.objects.find(function (z) { return todoist.zuordnung && todoist.zuordnung[z.id]; });
    if (o) return todoist.zuordnung[o.id];
    const e = tdProjekte.find(function (p) { return p.eingang; });
    return e ? e.id : (tdProjekte[0] ? tdProjekte[0].id : '');
  }
  const tdSortReihe = function (a, c) { return (a.reihenfolge || 0) - (c.reihenfolge || 0); };
  const tdSortTag = function (a, c) {   // Datum, dann Priorität, dann die Reihenfolge des Tages
    if ((a.faellig || '') !== (c.faellig || '')) return (a.faellig || '9999') < (c.faellig || '9999') ? -1 : 1;
    if ((a.prioritaet || 1) !== (c.prioritaet || 1)) return (c.prioritaet || 1) - (a.prioritaet || 1);
    return (a.tagesreihenfolge || 0) - (c.tagesreihenfolge || 0);
  };
  function tdBeschKurz(b) {
    const zeilen = String(b || '').split('\n').map(function (z) { return z.trim(); })
      .filter(function (z) { return z && z.indexOf('Hinzugefügt am') !== 0; });
    return zeilen.length ? tdKurz(zeilen[0], 110) : '';
  }
  function tdPasst(t) {
    if (tdFilter.projekt && t.projektId !== tdFilter.projekt) return false;
    if (tdFilter.label && (t.labels || []).indexOf(tdFilter.label) === -1) return false;
    if (!tdSuche) return true;
    const q = tdSuche.toLowerCase();
    return (t.inhalt || '').toLowerCase().indexOf(q) !== -1
      || (t.beschreibung || '').toLowerCase().indexOf(q) !== -1
      || (t.labels || []).some(function (l) { return l.toLowerCase().indexOf(q) !== -1; })
      || tdProjektName(t.projektId).toLowerCase().indexOf(q) !== -1;
  }

  // ---- Laden ----
  async function alleLaden() {
    if (!todoist.verbunden) { alleAufgaben = []; tdProjekte = []; tdSektionen = []; tdAbleiten(); return; }
    try {
      const u = await api('todoist/uebersicht');
      alleAufgaben = u.aufgaben || [];
      tdProjekte = u.projekte || [];
      tdSektionen = u.sektionen || [];
    } catch (e) {
      if (alleAufgaben === null) alleAufgaben = [];
      toast(e.message);
    }
    tdAbleiten();
  }
  // Wochenliste und Objektlisten aus der Übersicht ableiten
  function tdAbleiten() {
    const liste = alleAufgaben || [];
    const heute0 = tdHeute();
    const montag = new Date(heute0); montag.setDate(heute0.getDate() - ((heute0.getDay() + 6) % 7));
    const sonntag = new Date(montag); sonntag.setDate(montag.getDate() + 6);
    wocheListe = liste.filter(function (t) { return t.faellig && tdTag(t.faellig) <= sonntag; })
      .map(function (t) { const k = Object.assign({}, t); k.alt = tdTag(t.faellig) < montag; return k; })
      .sort(tdSortTag);
    aufgaben = {};
    ((data && data.objects) || []).forEach(function (o) {
      const pid = todoist.zuordnung && todoist.zuordnung[o.id];
      if (pid) aufgaben[o.id] = liste.filter(function (t) { return t.projektId === pid; });
    });
  }
  async function wocheLaden() { await alleLaden(); }
  async function aufgabenLaden() { if (alleAufgaben === null) await alleLaden(); else tdAbleiten(); }

  // ---- Abhaken mit kurzer Animation und "Rückgängig" ----
  function tdFertig(tid, el) {
    const t = tdFinde(tid);
    const zeile = el && el.closest ? el.closest('.td-zeile') : null;
    if (zeile) zeile.classList.add('erledigt');
    const weiter = function () {
      const ids = [tid].concat(tdNachfahren(tid));
      alleAufgaben = (alleAufgaben || []).filter(function (z) { return ids.indexOf(z.id) === -1; });
      tdAbleiten();
      if (modal && modal.kind === 'aufgabe' && modal.aufgabe.id === tid) modal = null;
      render();
      api('todoist/aufgabe/' + encodeURIComponent(tid) + '/erledigt', { method: 'POST' })
        .then(function () {
          toastAktion(t ? '„' + tdKurz(t.inhalt, 36) + '“ erledigt' : 'Aufgabe erledigt', 'Rückgängig', function () {
            api('todoist/aufgabe/' + encodeURIComponent(tid) + '/wieder', { method: 'POST' })
              .then(function () { return alleLaden(); })
              .then(function () { toast('Wieder offen'); render(); })
              .catch(function (e) { toast(e.message); });
          });
        })
        .catch(function (e) { toast(e.message); alleLaden().then(function () { render(); }); });
    };
    if (zeile && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) setTimeout(weiter, 380);
    else weiter();
  }
  function wocheErledigt(id) { tdFertig(id, null); }
  function aufgabeErledigt(oid, id) { tdFertig(id, null); }

  // ---- Dialoge im App-Stil (statt der grauen Browser-Fenster) ----
  // Liegt außerhalb von #app, damit ein Neuzeichnen der App den Dialog nicht wegwischt.
  // dialog({ titel, text, knoepfe: [{ label, wert, art }], feld: { typ, wert, platzhalter, nurLesen } })
  // → Promise mit { wert, eingabe } (wert des gedrückten Knopfs, null bei Esc/Abbrechen)
  function dialog(o) {
    return new Promise(function (fertig) {
      const alt = document.getElementById('dialog'); if (alt) alt.remove();
      const bd = document.createElement('div');
      bd.id = 'dialog';
      bd.setAttribute('data-theme', theme);
      const box = document.createElement('div'); box.className = 'dlg'; box.setAttribute('role', 'dialog');
      if (o.titel) { const h = document.createElement('h3'); h.textContent = o.titel; box.appendChild(h); }
      if (o.text) { const p = document.createElement('p'); p.textContent = o.text; box.appendChild(p); }
      let feld = null;
      if (o.feld) {
        feld = document.createElement(o.feld.typ === 'textarea' ? 'textarea' : 'input');
        if (o.feld.typ !== 'textarea') feld.type = o.feld.typ || 'text';
        feld.value = o.feld.wert || '';
        if (o.feld.platzhalter) feld.placeholder = o.feld.platzhalter;
        if (o.feld.nurLesen) feld.readOnly = true;
        if (o.feld.typ === 'textarea') feld.rows = 6;
        box.appendChild(feld);
      }
      const leiste = document.createElement('div'); leiste.className = 'dlg-knoepfe';
      const zu = function (wert) {
        bd.remove();
        document.removeEventListener('keydown', taste, true);
        fertig({ wert: wert, eingabe: feld ? feld.value : null });
      };
      (o.knoepfe || [{ label: 'OK', wert: true, art: 'primaer' }]).forEach(function (k) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = k.label;
        if (k.art) b.className = k.art;
        b.addEventListener('click', function () { zu(k.wert); });
        leiste.appendChild(b);
      });
      box.appendChild(leiste);
      bd.appendChild(box);
      bd.addEventListener('click', function (ev) { if (ev.target === bd) zu(null); });
      const taste = function (ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); zu(null); }
        if (ev.key === 'Enter' && (!feld || feld.tagName !== 'TEXTAREA')) {
          const haupt = (o.knoepfe || []).find(function (k) { return k.art === 'primaer'; });
          if (haupt) { ev.preventDefault(); ev.stopPropagation(); zu(haupt.wert); }
        }
      };
      document.addEventListener('keydown', taste, true);
      document.body.appendChild(bd);
      if (feld) { feld.focus(); if (o.feld.nurLesen) feld.select(); }
      else { const b = leiste.querySelector('.primaer') || leiste.querySelector('button'); if (b) b.focus(); }
    });
  }
  // Text zum Kopieren anzeigen, wenn die Zwischenablage nicht erreichbar ist
  function kopierDialog(text) {
    return dialog({ titel: 'Zum Kopieren', text: 'Der Text ist markiert — jetzt mit Strg+C (am Mac Cmd+C) kopieren.',
      feld: { typ: 'textarea', wert: text, nurLesen: true }, knoepfe: [{ label: 'Fertig', wert: true, art: 'primaer' }] });
  }
  // Löschen ohne Rückfrage: erst nach ein paar Sekunden wirklich ausführen, bis dahin "Rückgängig"
  function spaeterLoeschen(text, ausfuehren, rueckgaengig) {
    let abgebrochen = false;
    const uhr = setTimeout(function () { if (!abgebrochen) ausfuehren(); }, 6000);
    toastAktion(text, 'Rückgängig', function () { abgebrochen = true; clearTimeout(uhr); rueckgaengig(); });
    // Seite wird geschlossen, bevor die Zeit um ist: dann jetzt ausführen
    window.addEventListener('pagehide', function () { if (!abgebrochen) { clearTimeout(uhr); abgebrochen = true; ausfuehren(); } }, { once: true });
  }

  function toastAktion(text, label, fn) {
    const old = root.querySelector('.toast'); if (old) old.remove();
    const el = document.createElement('div'); el.className = 'toast mit-aktion';
    const sp = document.createElement('span'); sp.textContent = text; el.appendChild(sp);
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', function () { el.remove(); clearTimeout(toastTimer); fn(); });
    el.appendChild(b);
    root.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, 8000);
  }

  // ---- Wischen am Handy: nach rechts = erledigt, nach links = auf morgen ----
  function tdAufMorgen(tid) {
    const t = tdFinde(tid); if (!t) return;
    const alt = t.faellig || '';
    tdDatumSetzen(tid, tdPlus(1));
    toastAktion('„' + tdKurz(t.inhalt, 36) + '“ auf morgen', 'Rückgängig', function () { tdDatumSetzen(tid, alt); });
  }
  (function () {
    const SCHWELLE = 90;
    let zeile = null, x0 = 0, y0 = 0, dx = 0, richtung = null, gewischt = false;
    document.addEventListener('touchstart', function (ev) {
      zeile = null;
      if (ev.touches.length !== 1 || !ev.target.closest) return;
      const z = ev.target.closest('.td-zeile[data-tid]');
      if (!z || ev.target.closest('.td-menue')) return;
      zeile = z; x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; richtung = null;
    }, { passive: true });
    document.addEventListener('touchmove', function (ev) {
      if (!zeile) return;
      const mx = ev.touches[0].clientX - x0, my = ev.touches[0].clientY - y0;
      if (!richtung) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        richtung = Math.abs(mx) > Math.abs(my) * 1.3 ? 'quer' : 'hoch';
        if (richtung === 'quer') zeile.classList.add('wischt');
      }
      if (richtung !== 'quer') return;
      dx = mx;
      zeile.style.transform = 'translateX(' + dx + 'px)';
      zeile.classList.toggle('wisch-fertig', dx > SCHWELLE);
      zeile.classList.toggle('wisch-morgen', dx < -SCHWELLE);
    }, { passive: true });
    const ende = function () {
      if (!zeile) return;
      const z = zeile, tid = z.getAttribute('data-tid'), weit = dx;
      zeile = null;
      if (richtung !== 'quer') return;
      gewischt = true; setTimeout(function () { gewischt = false; }, 400);
      z.classList.remove('wischt', 'wisch-fertig', 'wisch-morgen');
      z.style.transform = '';
      if (weit > SCHWELLE) tdFertig(tid, z);
      else if (weit < -SCHWELLE) tdAufMorgen(tid);
    };
    document.addEventListener('touchend', ende);
    document.addEventListener('touchcancel', function () { dx = 0; ende(); });
    // Nach dem Wischen keinen Klick auf die Zeile auslösen
    document.addEventListener('click', function (ev) {
      if (gewischt) { ev.stopPropagation(); ev.preventDefault(); gewischt = false; }
    }, true);
  })();

  // ---- Ändern direkt aus der Liste ----
  function tdDatumSetzen(tid, datum) {
    const t = tdFinde(tid); if (!t) return;
    tdMenue = null;
    const alt = { faellig: t.faellig, zeit: t.faelligZeit };
    t.faellig = datum || null; t.faelligZeit = null; tdAbleiten(); render();
    api('todoist/aufgabe/' + encodeURIComponent(tid), { method: 'POST', body: { faellig: datum || '' } })
      .then(function () { return alleLaden(); }).then(function () { render(); })
      .catch(function (e) { toast(e.message); t.faellig = alt.faellig; t.faelligZeit = alt.zeit; tdAbleiten(); render(); });
  }
  function tdPrioSetzen(tid, p) {
    const t = tdFinde(tid); if (!t) return;
    tdMenue = null;
    const alt = t.prioritaet; t.prioritaet = p; render();
    api('todoist/aufgabe/' + encodeURIComponent(tid), { method: 'POST', body: { prioritaet: p } })
      .then(function () { return alleLaden(); }).then(function () { render(); })
      .catch(function (e) { toast(e.message); t.prioritaet = alt; render(); });
  }
  function tdVerschieben(tid, pid) {
    const t = tdFinde(tid); if (!t || !pid || t.projektId === pid) { tdMenue = null; render(); return; }
    tdMenue = null;
    api('todoist/aufgabe/' + encodeURIComponent(tid) + '/verschieben', { method: 'POST', body: { projektId: pid } })
      .then(function () { return alleLaden(); })
      .then(function () { toast('Nach „' + tdProjektName(pid) + '“ verschoben'); render(); })
      .catch(function (e) { toast(e.message); render(); });
  }
  function tdLoeschen(tid) {
    const t = tdFinde(tid); if (!t) return;
    tdMenue = null;
    // Sofort aus der Liste nehmen, in Todoist erst nach ein paar Sekunden löschen
    const vorher = alleAufgaben;
    alleAufgaben = (alleAufgaben || []).filter(function (x) { return x.id !== tid; });
    if (modal && modal.kind === 'aufgabe' && modal.aufgabe.id === tid) modal = null;
    tdAbleiten(); render();
    spaeterLoeschen('„' + tdKurz(t.inhalt, 40) + '“ gelöscht', function () {
      api('todoist/aufgabe/' + encodeURIComponent(tid), { method: 'DELETE' })
        .then(function () { return alleLaden(); }).then(function () { render(); })
        .catch(function (e) { fehlerToast(e.message); alleLaden().then(function () { render(); }); });
    }, function () {
      alleAufgaben = vorher; tdAbleiten(); render(); toast('Wiederhergestellt');
    });
  }
  // Alles Überfällige auf einen Schlag auf ein neues Datum setzen
  async function tdNeuplanen(datum) {
    tdMenue = null;
    const heute0 = tdHeute();
    const spaet = (alleAufgaben || []).filter(function (t) { return t.faellig && tdTag(t.faellig) < heute0 && tdPasst(t); });
    if (!spaet.length) { render(); return; }
    let ok = 0;
    for (const t of spaet) {
      try {
        await api('todoist/aufgabe/' + encodeURIComponent(t.id), { method: 'POST', body: { faellig: datum } });
        ok++;
      } catch (e) { toast(e.message); }
    }
    await alleLaden();
    toast(ok + (ok === 1 ? ' Aufgabe' : ' Aufgaben') + ' neu geplant');
    render();
  }

  // ---- Aufgabe öffnen (Fenster wie in Todoist) ----
  async function tdOeffnen(tid) {
    const t = tdFinde(tid); if (!t) return;
    const o = objektVonProjekt(t.projektId);
    tdMenue = null;
    if (tdEditor && (tdEditor.ort === 'schnell' || tdEditor.ort.indexOf('unter:') === 0)) tdEditor = null;
    modal = { kind: 'aufgabe', oid: o ? o.id : null, aufgabe: t, kommentare: null, entwurf: null };
    render();
    try { modal.kommentare = await api('todoist/aufgabe/' + encodeURIComponent(tid) + '/kommentare'); }
    catch (e) { modal.kommentare = []; }
    if (modal && modal.kind === 'aufgabe' && modal.aufgabe.id === tid) render();
  }
  function aufgabeOeffnen(oid, tid) { tdOeffnen(tid); }
  // Was gerade im Fenster steht, vor einem Neuaufbau festhalten
  function modalEntwurfMerken() {
    if (!modal || modal.kind !== 'aufgabe') return;
    const i = root.querySelector('#t-inhalt');
    if (!i) return;
    modal.entwurf = {
      inhalt: i.value, beschreibung: val('t-besch'), faellig: val('t-faellig'),
      prioritaet: Number(val('t-prio')) || 1, projektId: val('t-projekt')
    };
    const v = root.querySelector('#t-verlauf');
    if (v) modal.verlaufText = v.value;
  }
  async function aufgabeSpeichern() {
    const t = modal.aufgabe;
    const neuesProjekt = val('t-projekt');
    try {
      await api('todoist/aufgabe/' + encodeURIComponent(t.id), {
        method: 'POST',
        body: {
          inhalt: val('t-inhalt'),
          beschreibung: val('t-besch'),
          faellig: val('t-faellig'),
          prioritaet: Number(val('t-prio')) || 1
        }
      });
      if (neuesProjekt && neuesProjekt !== t.projektId) {
        await api('todoist/aufgabe/' + encodeURIComponent(t.id) + '/verschieben', { method: 'POST', body: { projektId: neuesProjekt } });
      }
      modal = null; tdEditor = null;
      await alleLaden();
      toast('Gespeichert');
      render();
    } catch (e) { toast(e.message); }
  }
  async function kommentarSenden() {
    const feld = root.querySelector('#t-kommentar');
    if (!feld || !feld.value.trim()) return;
    modalEntwurfMerken();
    try {
      await api('todoist/aufgabe/' + encodeURIComponent(modal.aufgabe.id) + '/kommentar', {
        method: 'POST', body: { inhalt: feld.value.trim() }
      });
      modal.kommentare = await api('todoist/aufgabe/' + encodeURIComponent(modal.aufgabe.id) + '/kommentare');
      const t = tdFinde(modal.aufgabe.id); if (t) t.kommentare = modal.kommentare.length;
      toast('Kommentar gesendet');
      render();
    } catch (e) { toast(e.message); }
  }
  function aufgabeLoeschen() { tdLoeschen(modal.aufgabe.id); }
  function unteraufgabeAnlegen() { tdEditorAbsenden(); }
  function aufgabeAnlegen() { tdEditorAbsenden(); }
  function alleAnlegen() { tdEditorAbsenden(); }

  // ---- Datum, Uhrzeit und Priorität aus dem Text erkennen ("morgen Rechnung schreiben") ----
  function tdErkennen(text) {
    let rest = ' ' + String(text || '') + ' ';
    let datum = null, zeit = null, prio = 0, m;
    const heute0 = tdHeute();
    const weg = function (s) { rest = rest.replace(s, ' '); };
    const setz = function (d) { datum = tdIso(d); };
    const ende = '(?=[\\s,!?]|\\.\\s|\\.$)';
    if ((m = rest.match(/\s[pP]([1-4])(?=\s)/))) { prio = 5 - Number(m[1]); weg(m[0]); }
    if ((m = rest.match(new RegExp('\\s(?:um\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*uhr' + ende, 'i')))) {
      const h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0;
      if (h < 24 && mi < 60) { zeit = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0'); weg(m[0]); }
    }
    const monate = ['januar|jan', 'februar|feb', 'märz|maerz|mär|mrz', 'april|apr', 'mai', 'juni|jun', 'juli|jul',
      'august|aug', 'september|sept|sep', 'oktober|okt', 'november|nov', 'dezember|dez'];
    // 5.9., 05.09.2026
    if ((m = rest.match(/\s(?:am\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?=[\s,!?]|$)/))) {
      const t = Number(m[1]), mo = Number(m[2]);
      if (t >= 1 && t <= 31 && mo >= 1 && mo <= 12) {
        let j = m[3] ? Number(m[3]) : heute0.getFullYear(); if (j < 100) j += 2000;
        let d = new Date(j, mo - 1, t);
        if (!m[3] && d < heute0) d = new Date(j + 1, mo - 1, t);
        setz(d); weg(m[0]);
      }
    }
    // 5. September, 5. Sept. 2026
    if (!datum && (m = rest.match(new RegExp('\\s(?:am\\s+)?(\\d{1,2})\\.?\\s*(' + monate.join('|') + ')\\.?(?:\\s+(\\d{4}))?' + ende, 'i')))) {
      const t = Number(m[1]);
      const mo = monate.findIndex(function (x) { return new RegExp('^(' + x + ')$', 'i').test(m[2]); });
      if (t >= 1 && t <= 31 && mo !== -1) {
        let j = m[3] ? Number(m[3]) : heute0.getFullYear();
        let d = new Date(j, mo, t);
        if (!m[3] && d < heute0) d = new Date(j + 1, mo, t);
        setz(d); weg(m[0]);
      }
    }
    if (!datum) {
      const tage = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
      const kurz = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'];
      const regeln = [
        [new RegExp('\\s(heute)' + ende, 'i'), function () { return tdPlus(0); }],
        [new RegExp('\\s(übermorgen|uebermorgen)' + ende, 'i'), function () { return tdPlus(2); }],
        [new RegExp('\\s(morgen)' + ende, 'i'), function () { return tdPlus(1); }],
        [new RegExp('\\s(?:am\\s+)?wochenende' + ende, 'i'), tdWochenende],
        [new RegExp('\\s(?:nächste|naechste|kommende)\\s+woche' + ende, 'i'), tdNaechsteWoche],
        [new RegExp('\\s(?:nächsten|naechsten|kommenden)\\s+monat' + ende, 'i'), function () {
          const d = tdHeute(); d.setDate(1); d.setMonth(d.getMonth() + 1); return d;
        }],
        [new RegExp('\\sin\\s+(\\d+)\\s+(tag|tagen|woche|wochen|monat|monaten)' + ende, 'i'), function (x) {
          const n = Number(x[1]);
          if (/^tag/i.test(x[2])) return tdPlus(n);
          if (/^woche/i.test(x[2])) return tdPlus(7 * n);
          const d = tdHeute(); d.setMonth(d.getMonth() + n); return d;
        }],
        [new RegExp('\\s(?:(am|nächsten|naechsten|kommenden)\\s+)?(' + tage.join('|') + ')' + ende, 'i'), function (x) {
          const ziel = tage.indexOf(x[2].toLowerCase());
          let diff = (ziel - heute0.getDay() + 7) % 7;
          if (diff === 0 && /^(nächsten|naechsten|kommenden)$/i.test(x[1] || '')) diff = 7;
          return tdPlus(diff);
        }],
        [new RegExp('\\s(am|nächsten|naechsten|kommenden)\\s+(' + kurz.join('|') + ')\\.?' + ende, 'i'), function (x) {
          const ziel = kurz.indexOf(x[2].toLowerCase());
          let diff = (ziel - heute0.getDay() + 7) % 7;
          if (diff === 0 && /^(nächsten|naechsten|kommenden)$/i.test(x[1])) diff = 7;
          return tdPlus(diff);
        }]
      ];
      for (const r of regeln) {
        if ((m = rest.match(r[0]))) { setz(r[1](m)); weg(m[0]); break; }
      }
    }
    rest = rest.replace(/\s+/g, ' ').trim().replace(/^[,\-–]\s*/, '').replace(/\s*[,\-–]$/, '');
    return { datum: datum, zeit: zeit, prio: prio, rest: rest };
  }

  // ---- Eingabekasten für eine neue Aufgabe ----
  function tdEditorOeffnen(v) {
    tdMenue = null;
    tdEditor = {
      ort: v.ort, projektId: v.projektId || '', sektion: v.sektion || '', eltern: v.eltern || '',
      faellig: v.faellig || '', zeit: '', fest: false, prio: 1, inhalt: '', besch: '', fokus: 'titel',
      vorgabe: v.faellig || ''
    };
  }
  function tdEditorMerken() {
    if (!tdEditor) return;
    const t = root.querySelector('#td-e-titel'), b = root.querySelector('#td-e-besch');
    const p = root.querySelector('#td-e-projekt'), s = root.querySelector('#td-e-sektion');
    const z = root.querySelector('#td-e-zeit');
    if (t) tdEditor.inhalt = t.value;
    if (b) tdEditor.besch = b.value;
    if (p) tdEditor.projektId = p.value;
    if (s) tdEditor.sektion = s.value;
    if (z) tdEditor.zeit = z.value;
    if (t && document.activeElement === t) tdEditor.fokus = 'titel';
    else if (b && document.activeElement === b) tdEditor.fokus = 'besch';
  }
  function tdEditorHtml() {
    const e = tdEditor;
    const erk = tdErkennen(e.inhalt || '');
    const faellig = e.fest ? e.faellig : (erk.datum || e.faellig);
    const zeit = e.zeit || (e.fest ? '' : (erk.zeit || ''));
    const wann = faellig ? tdWann({ faellig: faellig }) : null;
    const prio = e.prio > 1 ? e.prio : (erk.prio || 1);
    const projekte = tdProjektListe();
    const sekt = tdSektionen.filter(function (s) { return s.projektId === e.projektId; }).sort(tdSortReihe);
    let html = '<div class="td-editor" id="td-editor">'
      + '<input type="text" class="td-e-titel" id="td-e-titel" placeholder="' + (e.eltern ? 'Unteraufgabe' : 'Aufgabenname') + '" value="' + esc(e.inhalt || '') + '" autocomplete="off" spellcheck="false">'
      + '<input type="text" class="td-e-besch" id="td-e-besch" placeholder="Beschreibung" value="' + esc(e.besch || '') + '" autocomplete="off">'
      + '<div class="td-e-chips">'
      + '<span class="td-chipwrap"><button type="button" class="td-chip' + (wann ? ' gesetzt ' + wann.klasse : '') + '" id="td-e-datumchip" data-act="td-menue" data-typ="e-datum">'
      + TDI.kalender + (wann ? esc(wann.text) + (zeit ? ' ' + zeit : '') : 'Datum') + '</button>'
      + '<button type="button" class="td-chip-x' + (faellig ? '' : ' aus') + '" id="td-e-datumx" data-act="td-e-datum" data-datum="" title="Datum entfernen">' + TDI.x + '</button>'
      + (tdMenue && tdMenue.typ === 'e-datum' ? tdMenueDatum(faellig, 'td-e-datum', '', { keinDatum: false }) : '')
      + '</span>'
      + '<span class="td-chipwrap"><label class="td-chip td-zeitchip' + (zeit ? ' gesetzt' : '') + '" for="td-e-zeit">'
      + '\u23F1 ' + (zeit ? esc(zeit) : 'Uhrzeit')
      + '<input type="time" id="td-e-zeit" value="' + esc(e.zeit || '') + '"></label>'
      + (e.zeit ? '<button type="button" class="td-chip-x" data-act="td-e-zeit-weg" title="Uhrzeit entfernen">' + TDI.x + '</button>' : '')
      + '</span>'
      + '<span class="td-chipwrap"><button type="button" class="td-chip' + (prio > 1 ? ' gesetzt f' + prio : '') + '" id="td-e-priochip" data-act="td-menue" data-typ="e-prio">'
      + (prio > 1 ? TDI.flagge : TDI.flaggeLeer) + (prio > 1 ? 'Priorität ' + (5 - prio) : 'Priorität') + '</button>'
      + (tdMenue && tdMenue.typ === 'e-prio' ? tdMenuePrio(prio, 'td-e-prio', '') : '')
      + '</span>'
      + '</div>'
      + '<div class="td-e-fuss">';
    if (!e.eltern) {
      html += '<select id="td-e-projekt" title="Projekt">' + projekte.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === e.projektId ? ' selected' : '') + '>'
          + esc(p.eingang ? 'Eingang' : p.name) + '</option>';
      }).join('') + '</select>';
      if (sekt.length) {
        html += '<select id="td-e-sektion" title="Abschnitt"><option value="">Ohne Abschnitt</option>' + sekt.map(function (s) {
          return '<option value="' + esc(s.id) + '"' + (s.id === e.sektion ? ' selected' : '') + '>' + esc(s.name) + '</option>';
        }).join('') + '</select>';
      }
    }
    html += '<div class="spacer"></div>'
      + '<button type="button" data-act="td-e-abbruch">Abbrechen</button>'
      + '<button type="button" class="td-ok" data-act="td-e-ok">' + (e.eltern ? 'Unteraufgabe hinzufügen' : 'Aufgabe hinzufügen') + '</button>'
      + '</div></div>';
    return html;
  }
  // Chips beim Tippen nachführen, ohne die Seite neu aufzubauen
  function tdEditorLive() {
    if (!tdEditor) return;
    const t = root.querySelector('#td-e-titel'); if (!t) return;
    const erk = tdErkennen(t.value);
    const chip = root.querySelector('#td-e-datumchip'), x = root.querySelector('#td-e-datumx');
    if (chip && !tdEditor.fest) {
      const faellig = erk.datum || tdEditor.faellig;
      const wann = faellig ? tdWann({ faellig: faellig }) : null;
      chip.className = 'td-chip' + (wann ? ' gesetzt ' + wann.klasse : '');
      chip.innerHTML = TDI.kalender + (wann ? esc(wann.text) + (erk.zeit ? ' ' + erk.zeit : '') : 'Datum');
      if (x) x.className = 'td-chip-x' + (faellig ? '' : ' aus');
    }
    const pc = root.querySelector('#td-e-priochip');
    if (pc && (tdEditor.prio || 1) === 1) {
      pc.className = 'td-chip' + (erk.prio ? ' gesetzt f' + erk.prio : '');
      pc.innerHTML = (erk.prio ? TDI.flagge : TDI.flaggeLeer) + (erk.prio ? 'Priorität ' + (5 - erk.prio) : 'Priorität');
    }
  }
  async function tdEditorAbsenden() {
    if (!tdEditor) return;
    tdEditorMerken();
    const e = tdEditor;
    const erk = tdErkennen(e.inhalt || '');
    let inhalt = (e.inhalt || '').trim();
    let faellig = e.faellig || '', zeit = e.zeit || '', prio = e.prio || 1;
    if (!e.fest && (erk.datum || erk.zeit)) {
      if (erk.datum) faellig = erk.datum;
      if (erk.zeit && !zeit) zeit = erk.zeit;
      inhalt = erk.rest;
    }
    if (zeit && !faellig) faellig = e.vorgabe || heuteISO();
    if (prio === 1 && erk.prio) { prio = erk.prio; inhalt = erk.rest; }
    if (!inhalt) { toast('Erst aufschreiben, was zu tun ist'); return; }
    const koerper = { inhalt: inhalt, beschreibung: e.besch || '' };
    if (prio > 1) koerper.prioritaet = prio;
    if (e.eltern) koerper.eltern = e.eltern;
    else { koerper.projektId = e.projektId || ''; if (e.sektion) koerper.sektion = e.sektion; }
    if (faellig) {
      koerper.faellig = faellig;
      if (zeit) koerper.faelligZeit = new Date(faellig + 'T' + zeit + ':00').toISOString();
    }
    try {
      await api('todoist/aufgabe', { method: 'POST', body: koerper });
      // Felder gleich leeren, damit der Neuaufbau nicht den alten Text wieder aufliest
      const tf = root.querySelector('#td-e-titel'), bf = root.querySelector('#td-e-besch');
      const zf = root.querySelector('#td-e-zeit');
      if (tf) tf.value = '';
      if (bf) bf.value = '';
      if (zf) zf.value = '';
      if (e.ort === 'schnell') { modal = null; tdEditor = null; }
      else {
        // Der Kasten bleibt offen für die nächste Aufgabe, wie in Todoist
        tdEditor = Object.assign({}, e, { inhalt: '', besch: '', prio: 1, zeit: '', fest: false, faellig: e.vorgabe, fokus: 'titel' });
      }
      await alleLaden();
      toast('„' + tdKurz(inhalt, 36) + '“ hinzugefügt');
      render();
    } catch (err) { toast(err.message); }
  }
  function tdSchnell() {
    if (!todoist.verbunden) { toast('Erst Todoist verbinden'); return; }
    tdEditorOeffnen({ ort: 'schnell', projektId: tdStandardProjekt() });
    modal = { kind: 'schnell' };
    render();
  }
  // Nach dem Neuaufbau den Fokus zurück ins Eingabefeld
  function tdFokus() {
    if (tdSucheFokus) {
      tdSucheFokus = false;
      const s = root.querySelector('#td-suche');
      if (s) { s.focus(); try { s.setSelectionRange(s.value.length, s.value.length); } catch (e) { /* egal */ } }
      return;
    }
    if (!tdEditor || !tdEditor.fokus) return;
    const el = root.querySelector(tdEditor.fokus === 'besch' ? '#td-e-besch' : '#td-e-titel');
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* egal */ }
  }

  // Freie Anfangszeiten heute: Arbeitszeit aus dem Tagesplan minus alles mit Uhrzeit, ab jetzt
  function freieLueckenHeute(dauer) {
    const e = planEinst || {};
    const min = function (hhmm, st) { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : st; };
    const jetzt = new Date();
    let von = Math.max(min(e.start, 480), Math.ceil((jetzt.getHours() * 60 + jetzt.getMinutes()) / 5) * 5);
    const ende = min(e.ende, 1020);
    const belegt = kalZeitplan(heuteISO(), kalBelegung()).map(function (x) { return [x.von, x.von + (x.dauer || 30)]; });
    if (e.pauseVon && e.pauseBis) belegt.push([min(e.pauseVon, 720), min(e.pauseBis, 780)]);
    belegt.sort(function (a, b) { return a[0] - b[0]; });
    const zeiten = [];
    const uhr = function (m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    while (von + dauer <= ende && zeiten.length < 6) {
      const stoert = belegt.find(function (b) { return b[0] < von + dauer && b[1] > von; });
      if (stoert) { von = Math.ceil(stoert[1] / 5) * 5; continue; }
      zeiten.push(uhr(von));
      von += Math.max(30, dauer);
    }
    return zeiten;
  }

  // ---- Bausteine der Anzeige ----
  function tdMenueDatum(aktuell, act, tid, opt) {
    opt = opt || {};
    const heute0 = tdHeute();
    const eintrag = function (name, d, farbe, zeichen) {
      const wt = tdWochentag(d, true);
      return '<button type="button" class="' + farbe + '" data-act="' + act + '" data-tid="' + tid + '" data-datum="' + tdIso(d) + '">'
        + zeichen + name + '<span class="td-m-rechts">' + wt + (d - heute0 > 6 * 86400000 ? ' ' + tdDatumLang(d) : '') + '</span></button>';
    };
    return '<div class="td-menue">'
      + eintrag('Heute', heute0, 'gruen', tdHeuteZeichen(heute0.getDate()))
      + eintrag('Morgen', tdPlus(1), 'orange', TDI.sonne)
      + eintrag('Dieses Wochenende', tdWochenende(), 'blau', TDI.sofa)
      + eintrag('Nächste Woche', tdNaechsteWoche(), 'lila', TDI.weiter)
      + (opt.keinDatum !== false
          ? '<div class="td-m-trenner"></div><button type="button" data-act="' + act + '" data-tid="' + tid + '" data-datum="">' + TDI.kreisX + 'Kein Datum</button>'
          : '')
      + '<div class="td-m-trenner"></div>'
      + '<input type="date" class="td-m-datum" data-ziel="' + act + '" data-tid="' + tid + '" value="' + esc(aktuell || '') + '">'
      + '</div>';
  }
  function tdFlaggen(aktiv, act, tid) {
    return '<div class="td-flaggen">' + [4, 3, 2, 1].map(function (p) {
      return '<button type="button" class="td-flagge f' + p + (aktiv === p ? ' aktiv' : '') + '" data-act="' + act + '" data-tid="' + tid + '" data-p="' + p + '" title="Priorität ' + (5 - p) + '">'
        + (p === 1 ? TDI.flaggeLeer : TDI.flagge) + '</button>';
    }).join('') + '</div>';
  }
  function tdMenuePrio(aktiv, act, tid) {
    return '<div class="td-menue" style="min-width:0"><div class="td-m-titel">Priorität</div>' + tdFlaggen(aktiv, act, tid) + '</div>';
  }
  function tdMenueHtml(t) {
    if (tdMenue.typ === 'datum') return tdMenueDatum(t.faellig, 'td-setzen', t.id, {});
    if (tdMenue.typ === 'warten') {
      return '<div class="td-menue"><div class="td-m-titel">Nachfassen in</div>'
        + [[1, 'morgen'], [2, '2 Tagen'], [3, '3 Tagen'], [7, '1 Woche'], [14, '2 Wochen']].map(function (x) {
            return '<button type="button" data-act="td-warten" data-tid="' + t.id + '" data-tage="' + x[0] + '">⏳ ' + x[1]
              + '<span class="td-m-rechts">' + tdWochentag(tdPlus(x[0]), true) + ' ' + tdDatumLang(tdPlus(x[0])) + '</span></button>';
          }).join('')
        + (tdWartet(t) ? '<div class="td-m-trenner"></div><button type="button" data-act="td-warten-ende" data-tid="' + t.id + '">✓ Antwort ist da</button>' : '')
        + '</div>';
    }
    if (tdMenue.typ === 'uhrzeit') {
      const frei = freieLueckenHeute(t.dauer || 30);
      return '<div class="td-menue"><div class="td-m-titel">Freie Zeit heute' + (t.dauer ? ' · ' + t.dauer + ' Min' : '') + '</div>'
        + (frei.length
            ? '<div class="td-uhrchips">' + frei.map(function (z) {
                return '<button type="button" class="td-fchip" data-act="td-uhrzeit" data-tid="' + t.id + '" data-zeit="' + z + '">' + z + '</button>';
              }).join('') + '</div>'
            : '<div class="td-m-leer">Heute ist nichts mehr frei.</div>')
        + '<div class="td-m-trenner"></div>'
        + '<div class="td-m-titel">Andere Zeit</div><input type="time" class="td-m-zeit" data-tid="' + t.id + '">'
        + '</div>';
    }
    if (tdMenue.typ === 'projekt') {
      return '<div class="td-menue"><div class="td-m-titel">Verschieben nach</div>'
        + tdProjektListe().map(function (p) {
            return '<button type="button" data-act="td-verschieben" data-tid="' + t.id + '" data-projekt="' + esc(p.id) + '">'
              + '<span class="td-punkt" style="background:' + p.farbe + '"></span>' + esc(p.eingang ? 'Eingang' : p.name)
              + (p.id === t.projektId ? '<span class="td-m-rechts">aktuell</span>' : '') + '</button>';
          }).join('') + '</div>';
    }
    return '<div class="td-menue"><div class="td-m-titel">Priorität</div>' + tdFlaggen(t.prioritaet || 1, 'td-prio', t.id)
      + '<div class="td-m-trenner"></div>'
      + '<button type="button" data-act="td-menue" data-typ="datum" data-tid="' + t.id + '">' + TDI.kalender + 'Datum<span class="td-m-rechts">›</span></button>'
      + '<button type="button" data-act="td-menue" data-typ="uhrzeit" data-tid="' + t.id + '">◷ Uhrzeit heute<span class="td-m-rechts">›</span></button>'
      + '<button type="button" data-act="td-menue" data-typ="warten" data-tid="' + t.id + '">⏳ ' + (tdWartet(t) ? 'Wartet · nachfassen' : 'Wartet auf Antwort') + '<span class="td-m-rechts">›</span></button>'
      + '<button type="button" data-act="td-menue" data-typ="projekt" data-tid="' + t.id + '">' + TDI.ordner + 'In anderes Projekt<span class="td-m-rechts">›</span></button>'
      + '<button type="button" data-act="td-oeffnen" data-tid="' + t.id + '">' + TDI.stift + 'Bearbeiten</button>'
      + '<a class="td-m-link" href="' + esc(t.url) + '" target="_blank" rel="noopener">' + TDI.extern + 'In Todoist öffnen</a>'
      + '<div class="td-m-trenner"></div>'
      + '<button type="button" class="rot" data-act="td-loeschen" data-tid="' + t.id + '">' + TDI.muell + 'Löschen</button>'
      + '</div>';
  }
  // Eine Aufgabenzeile, wie sie überall in der App aussieht
  function tdZeile(t, o) {
    o = o || {};
    const w = tdWann(t);
    const kinder = tdKinder(t.id);
    const eltern = t.eltern ? tdFinde(t.eltern) : null;
    const zu = !!tdZu['a:' + t.id];
    const besch = tdBeschKurz(t.beschreibung);
    const proj = tdProjekt(t.projektId);
    let html = '<div class="td-zeile p' + (t.prioritaet || 1) + (o.ebene ? ' ebene-' + o.ebene : '')
      + (tdMenue && tdMenue.tid === t.id ? ' offen' : '') + '" data-tid="' + t.id + '">'
      + (o.klappbar && kinder.length
          ? '<button type="button" class="td-auf' + (zu ? ' zu' : '') + '" data-act="td-klappen" data-k="a:' + t.id + '" title="' + (zu ? 'Aufklappen' : 'Einklappen') + '">' + TDI.chevron + '</button>'
          : '')
      + '<button type="button" class="td-kreis" data-act="td-fertig" data-tid="' + t.id + '" title="Abhaken">' + TDI.check + '</button>'
      + '<div class="td-mitte" data-act="td-oeffnen" data-tid="' + t.id + '">'
      + '<div class="td-titel">' + esc(t.inhalt) + '</div>'
      + (besch ? '<div class="td-besch">' + esc(besch) + '</div>' : '')
      + '<div class="td-meta">'
      + (w ? '<span class="td-datum ' + w.klasse + '">' + TDI.kalender + esc(w.text) + (t.wiederkehrend ? TDI.wieder : '') + '</span>' : '')
      + (kinder.length ? '<span class="td-unter" title="Unteraufgaben">' + TDI.unter + kinder.length + '</span>' : '')
      + (t.kommentare ? '<span class="td-komm" title="Kommentare">' + TDI.kommentar + t.kommentare + '</span>' : '')
      + (t.labels || []).map(function (l) { return '<span class="td-label">' + TDI.label + esc(l) + '</span>'; }).join('')
      + (o.mitProjekt
          ? '<span class="td-projekt"><span>' + (eltern ? esc(tdKurz(eltern.inhalt, 24)) + ' <b>›</b> ' : '') + esc(tdProjektName(t.projektId)) + '</span>'
            + '<i style="background:' + (proj ? proj.farbe : 'var(--muted)') + '"></i></span>'
          : (eltern && !o.ebene ? '<span class="td-projekt"><span>' + esc(tdKurz(eltern.inhalt, 30)) + '</span></span>' : ''))
      + '</div></div>'
      + '<div class="td-aktionen">'
      + '<button type="button" class="nur-pc" data-act="td-oeffnen" data-tid="' + t.id + '" title="Bearbeiten">' + TDI.stift + '</button>'
      + '<button type="button" class="nur-pc" data-act="td-menue" data-typ="datum" data-tid="' + t.id + '" title="Datum">' + TDI.kalender + '</button>'
      + '<button type="button" data-act="td-menue" data-typ="mehr" data-tid="' + t.id + '" title="Mehr">' + TDI.mehr + '</button>'
      + '</div>'
      + (tdMenue && tdMenue.tid === t.id ? tdMenueHtml(t) : '')
      + '</div>';
    if (o.klappbar && kinder.length && !zu) {
      html += kinder.map(function (k) {
        return tdZeile(k, Object.assign({}, o, { ebene: Math.min(3, (o.ebene || 0) + 1) }));
      }).join('');
    }
    return html;
  }
  function tdNeuHtml(ort, v) {
    v = v || {};
    if (tdEditor && tdEditor.ort === ort) return tdEditorHtml();
    return '<button type="button" class="td-neu" data-act="td-neu" data-ort="' + esc(ort) + '" data-projekt="' + esc(v.projektId || '') + '"'
      + ' data-sektion="' + esc(v.sektion || '') + '" data-datum="' + esc(v.faellig || '') + '" data-eltern="' + esc(v.eltern || '') + '">'
      + '<span class="td-neu-kreis">' + TDI.plus + '</span>' + (v.text || 'Aufgabe hinzufügen') + '</button>';
  }
  // Ein Abschnitt mit Kopfzeile, Zähler und Zeilen
  function tdBlock(k, titel, liste, o) {
    o = o || {};
    const zu = !!tdZu[k];
    return '<div class="td-abschnitt' + (zu ? ' zu' : '') + '" id="' + esc(k) + '">'
      + '<div class="td-ab-kopf"><button type="button" class="td-klapp" data-act="td-klappen" data-k="' + esc(k) + '" title="Ein- oder ausklappen">' + TDI.chevron + '</button>'
      + '<span' + (o.rot ? ' class="rot"' : '') + '>' + titel + '</span>' + (liste.length ? '<span class="td-zahl">' + liste.length + '</span>' : '')
      + (o.neuplanen
          ? '<span class="td-chipwrap rechts"><button type="button" class="td-neuplanen" data-act="td-menue" data-typ="neuplanen" data-tid="">Neu planen</button>'
            + (tdMenue && tdMenue.typ === 'neuplanen' ? tdMenueDatum('', 'td-neuplanen', '', { keinDatum: false }) : '') + '</span>'
          : '')
      + '</div>'
      + '<div class="td-liste">' + liste.map(function (t) { return tdZeile(t, { mitProjekt: o.mitProjekt !== false, klappbar: !!o.klappbar }); }).join('')
      + (o.neu ? tdNeuHtml(o.neu.ort, o.neu) : '') + '</div></div>';
  }
  // Alle Aufgaben eines Projekts: erst ohne Abschnitt, dann Abschnitt für Abschnitt
  function tdProjektInhalt(pid, ortBasis) {
    const liste = (alleAufgaben || []).filter(function (t) { return t.projektId === pid && tdPasst(t); });
    const drin = {}; liste.forEach(function (t) { drin[t.id] = true; });
    const wurzeln = liste.filter(function (t) { return !t.eltern || !drin[t.eltern]; });
    const sekt = tdSektionen.filter(function (s) { return s.projektId === pid; }).sort(tdSortReihe);
    const ohne = wurzeln.filter(function (t) { return !t.sektion || !sekt.some(function (s) { return s.id === t.sektion; }); }).sort(tdSortReihe);
    let html = '<div class="td-liste">' + ohne.map(function (t) { return tdZeile(t, { klappbar: true }); }).join('')
      + tdNeuHtml(ortBasis, { projektId: pid }) + '</div>';
    sekt.forEach(function (s) {
      const drinS = wurzeln.filter(function (t) { return t.sektion === s.id; }).sort(tdSortReihe);
      const k = 's:' + s.id;
      html += '<div class="td-abschnitt' + (tdZu[k] ? ' zu' : '') + '">'
        + '<div class="td-ab-kopf"><button type="button" class="td-klapp" data-act="td-klappen" data-k="' + k + '" title="Ein- oder ausklappen">' + TDI.chevron + '</button>'
        + '<span>' + esc(s.name) + '</span><span class="td-zahl">' + drinS.length + '</span></div>'
        + '<div class="td-liste">' + drinS.map(function (t) { return tdZeile(t, { klappbar: true }); }).join('')
        + tdNeuHtml(ortBasis + ':s:' + s.id, { projektId: pid, sektion: s.id }) + '</div></div>';
    });
    return html;
  }
  function tdEintrag(a, zeichen, name, zahl, farbe) {
    return '<button type="button" class="' + (tdAnsicht === a ? 'aktiv' : '') + '" data-act="td-ansicht" data-a="' + esc(a) + '">'
      + (farbe ? '<span class="td-punkt" style="background:' + farbe + '"></span>' : zeichen)
      + '<span class="td-name">' + esc(name) + '</span>'
      + (zahl ? '<span class="td-zahl">' + zahl + '</span>' : '') + '</button>';
  }

  // ---- Die Aufgaben-Seite ----
  function aufgabenAbschnitt() {
    if (!todoist.verbunden) {
      return '<div class="tafel"><h3>Aufgaben</h3>'
        + '<div class="unit-type">Sobald Todoist verbunden ist, stehen hier alle offenen Aufgaben — wie in Todoist selbst.</div>'
        + '<div class="modal-actions" style="justify-content:flex-start;margin-top:10px">'
        + '<button class="tiny" data-act="todoist">Verbinden</button></div></div>';
    }
    if (alleAufgaben === null) {
      return '<div class="td"><div class="td-seite"></div><div class="td-inhalt"><div class="td-leer">Aufgaben werden geladen …</div></div></div>';
    }
    const heute0 = tdHeute();
    const alle = alleAufgaben;
    const spaet = alle.filter(function (t) { return t.faellig && tdTag(t.faellig) < heute0; });
    const heuteL = alle.filter(function (t) { return t.faellig === tdIso(heute0); });
    const zaehl = {};
    alle.forEach(function (t) { zaehl[t.projektId] = (zaehl[t.projektId] || 0) + 1; });
    const projekte = tdProjektListe();
    const wartend = alle.filter(tdWartet);

    // Filter-Chips: Objekt/Projekt und Label, dazu „Nach Objekt“ — nur was es wirklich gibt
    const filterLeiste = function (liste, mitProjekt) {
      const pz = {}, lz = {};
      liste.forEach(function (t) {
        pz[t.projektId] = (pz[t.projektId] || 0) + 1;
        (t.labels || []).forEach(function (l) { lz[l] = (lz[l] || 0) + 1; });
      });
      const chip = function (act, wert, name, zahl, an) {
        return '<button type="button" class="td-fchip' + (an ? ' an' : '') + '" data-act="' + act + '" data-wert="' + esc(wert) + '">'
          + esc(name) + (zahl ? ' <span>' + zahl + '</span>' : '') + '</button>';
      };
      let h = '<div class="td-filter">';
      if (mitProjekt) {
        h += chip('td-filter-projekt', '', 'Alle', liste.length, !tdFilter.projekt);
        h += projekte.filter(function (p) { return pz[p.id]; }).map(function (p) {
          return chip('td-filter-projekt', p.id, p.eingang ? 'Eingang' : p.name, pz[p.id], tdFilter.projekt === p.id);
        }).join('');
      }
      const labels = Object.keys(lz).sort();
      if (labels.length) {
        h += '<span class="td-ftrenner"></span>' + labels.map(function (l) {
          return chip('td-filter-label', l, l, lz[l], tdFilter.label === l);
        }).join('');
      }
      if (mitProjekt) h += '<span class="td-ftrenner"></span>' + chip('td-gruppieren', '', 'Nach Objekt', '', tdGruppiert);
      return h + '</div>';
    };
    // Gruppiert: ein Block je Projekt/Objekt statt nach Datum
    const nachObjekt = function (schluessel, liste) {
      const je = {};
      liste.forEach(function (t) { (je[t.projektId] = je[t.projektId] || []).push(t); });
      return projekte.filter(function (p) { return je[p.id]; }).map(function (p) {
        return tdBlock(schluessel + ':' + p.id, (p.eingang ? 'Eingang' : p.name) + ' · ' + je[p.id].length, je[p.id], {});
      }).join('');
    };

    // Seitenleiste (PC) und Chips (Handy)
    let seite = '<aside class="td-seite">'
      + '<button type="button" class="td-plus" data-act="td-schnell"><span class="td-neu-kreis">' + TDI.plus + '</span><span class="td-name">Aufgabe hinzufügen</span></button>'
      + tdEintrag('heute', tdHeuteZeichen(heute0.getDate()), 'Heute', spaet.length + heuteL.length)
      + tdEintrag('demnaechst', TDI.demnaechst, 'Demnächst', '')
      + tdEintrag('wartet', '<span class="td-sanduhr">⏳</span>', 'Wartet', wartend.length)
      + tdEintrag('alle', TDI.alle, 'Alle offenen', alle.length)
      + '<div class="td-gruppe">Meine Projekte</div>'
      + projekte.map(function (p) { return tdEintrag('projekt:' + p.id, '', p.eingang ? 'Eingang' : p.name, zaehl[p.id] || '', p.farbe); }).join('')
      + '</aside>';
    let chips = '<div class="td-chips">'
      + tdEintrag('heute', tdHeuteZeichen(heute0.getDate()), 'Heute', spaet.length + heuteL.length)
      + tdEintrag('demnaechst', TDI.demnaechst, 'Demnächst', '')
      + tdEintrag('wartet', '<span class="td-sanduhr">⏳</span>', 'Wartet', wartend.length)
      + tdEintrag('alle', TDI.alle, 'Alle', alle.length)
      + projekte.map(function (p) { return tdEintrag('projekt:' + p.id, '', p.eingang ? 'Eingang' : p.name, zaehl[p.id] || '', p.farbe); }).join('')
      + '</div>';

    const werkzeuge = '<div class="td-werkzeuge">'
      + '<span class="td-suche"><input type="text" id="td-suche" placeholder="Suchen" value="' + esc(tdSuche) + '" autocomplete="off">'
      + (tdSuche ? '<button type="button" class="td-suche-x" data-act="td-suche-leer" title="Suche leeren">' + TDI.x + '</button>' : '') + '</span>'
      + '<button type="button" data-act="td-frisch" title="Neu laden">' + TDI.frisch + '</button>'
      + '</div>';
    const kopf = function (titel, unter) {
      return '<div class="td-kopf"><h2>' + titel + '</h2>' + (unter ? '<span class="td-datum-unter">' + unter + '</span>' : '') + werkzeuge + '</div>';
    };
    const anzahl = function (n) {
      return '<div class="td-anzahl">' + TDI.fertigKreis + n + (n === 1 ? ' Aufgabe' : ' Aufgaben') + '</div>';
    };
    const tagTitel = function (d) {   // "1. Sep ‧ Morgen ‧ Dienstag" wie in Todoist
      const diff = Math.round((d - heute0) / 86400000);
      const wort = diff === 0 ? 'Heute' : (diff === 1 ? 'Morgen' : '');
      return tdDatumLang(d) + (wort ? ' ‧ ' + wort : '') + ' ‧ ' + tdWochentag(d, false);
    };
    const gefiltert = function (l) { return l.filter(tdPasst).sort(tdSortTag); };
    let inhalt = '';

    if (tdAnsicht === 'heute') {
      const s = gefiltert(spaet), h = gefiltert(heuteL);
      inhalt += kopf('Heute', tdWochentag(heute0, true) + ' ' + tdDatumLang(heute0)) + anzahl(s.length + h.length);
      inhalt += filterLeiste(spaet.concat(heuteL), true);
      if (tdGruppiert) inhalt += nachObjekt('gh', s.concat(h));
      else {
        if (s.length) inhalt += tdBlock('ab:spaet', 'Überfällig', s, { rot: true, neuplanen: true });
        inhalt += tdBlock('ab:heute', tagTitel(heute0), h, { neu: { ort: 'heute', projektId: tdStandardProjekt(), faellig: tdIso(heute0) } });
      }
      if (!s.length && !h.length && !tdSuche) inhalt += '<div class="td-leer"><b>Für heute ist alles erledigt</b>Genieß den freien Kopf — oder plane oben schon den nächsten Schritt.</div>';

    } else if (tdAnsicht === 'demnaechst') {
      const proTag = {};
      alle.forEach(function (t) { if (t.faellig) proTag[t.faellig] = (proTag[t.faellig] || 0) + 1; });
      inhalt += kopf('Demnächst', heute0.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }));
      inhalt += '<div class="td-wochenleiste">' + [0, 1, 2, 3, 4, 5, 6].map(function (i) {
        const d = tdPlus(i);
        return '<button type="button" class="td-tag' + (i === 0 ? ' heute' : '') + '" data-act="td-spring" data-ziel="tag:' + tdIso(d) + '">'
          + '<span>' + tdWochentag(d, true) + '</span><b>' + d.getDate() + '</b><i class="' + (proTag[tdIso(d)] ? '' : 'leer') + '"></i></button>';
      }).join('') + '</div>';
      const s = gefiltert(spaet);
      if (s.length) inhalt += tdBlock('ab:spaet', 'Überfällig', s, { rot: true, neuplanen: true });
      for (let i = 0; i < 14; i++) {
        const d = tdPlus(i), iso = tdIso(d);
        const l = gefiltert(alle.filter(function (t) { return t.faellig === iso; }));
        inhalt += tdBlock('tag:' + iso, tagTitel(d), l, { neu: { ort: 'tag:' + iso, projektId: tdStandardProjekt(), faellig: iso } });
      }
      const grenze = tdIso(tdPlus(13));
      const spaeter = gefiltert(alle.filter(function (t) { return t.faellig && t.faellig > grenze; }));
      if (spaeter.length) inhalt += tdBlock('ab:spaeter', 'Später', spaeter, {});

    } else if (tdAnsicht === 'alle') {
      const tag = (heute0.getDay() + 6) % 7;
      const sonntag = tdIso(tdPlus(6 - tag));
      const g = { spaet: [], heute: [], woche: [], spaeter: [], ohne: [] };
      const heuteIso = tdIso(heute0);
      alle.forEach(function (t) {
        if (!t.faellig) g.ohne.push(t);
        else if (t.faellig < heuteIso) g.spaet.push(t);
        else if (t.faellig === heuteIso) g.heute.push(t);
        else if (t.faellig <= sonntag) g.woche.push(t);
        else g.spaeter.push(t);
      });
      const gs = gefiltert(g.spaet), gh = gefiltert(g.heute), gw = gefiltert(g.woche), gsp = gefiltert(g.spaeter), go = gefiltert(g.ohne);
      inhalt += kopf('Alle offenen Aufgaben') + anzahl(gs.length + gh.length + gw.length + gsp.length + go.length);
      inhalt += filterLeiste(alle, true);
      if (tdGruppiert) inhalt += nachObjekt('ga', gs.concat(gh, gw, gsp, go));
      else if (gs.length) inhalt += tdBlock('ab:spaet', 'Überfällig', gs, { rot: true, neuplanen: true });
      if (!tdGruppiert) {
        if (gh.length) inhalt += tdBlock('ab:heute', 'Heute', gh, {});
        if (gw.length) inhalt += tdBlock('ab:woche', 'Diese Woche', gw, {});
        if (gsp.length) inhalt += tdBlock('ab:spaeter', 'Später', gsp, {});
        inhalt += tdBlock('ab:ohne', 'Ohne Datum', go, { neu: { ort: 'alle', projektId: tdStandardProjekt() } });
      }

    } else if (tdAnsicht === 'wartet') {
      // Wartet auf Antwort: fällig heute oder früher = jetzt nachfassen, der Rest wartet noch
      const heuteIso = tdIso(heute0);
      const w = gefiltert(wartend);
      const jetzt = w.filter(function (t) { return !t.faellig || t.faellig <= heuteIso; });
      const noch = w.filter(function (t) { return t.faellig && t.faellig > heuteIso; });
      inhalt += kopf('Wartet auf Antwort') + anzahl(w.length);
      inhalt += filterLeiste(wartend, true);
      if (jetzt.length) inhalt += tdBlock('ab:nachfassen', 'Jetzt nachfassen', jetzt, { rot: true });
      if (noch.length) inhalt += tdBlock('ab:wartet', 'Wartet noch', noch, {});
      if (!w.length) inhalt += '<div class="td-leer"><b>Du wartest auf niemanden</b>Im Menü einer Aufgabe (⋯) „Wartet auf Antwort“ wählen — dann erinnert dich die App ans Nachfassen.</div>';

    } else if (tdAnsicht.indexOf('projekt:') === 0) {
      const pid = tdAnsicht.slice(8);
      const p = tdProjekt(pid);
      const o = objektVonProjekt(pid);
      const n = alle.filter(function (t) { return t.projektId === pid; }).length;
      inhalt += kopf('<span class="td-punkt" style="background:' + (p ? p.farbe : 'var(--muted)') + '"></span>' + esc(p ? (p.eingang ? 'Eingang' : p.name) : 'Projekt'),
        o ? esc(o.name) : '') + anzahl(n);
      inhalt += filterLeiste(alle.filter(function (t) { return t.projektId === pid; }), false);
      inhalt += tdProjektInhalt(pid, 'projekt:' + pid);
      if (!n && !tdSuche) inhalt += '<div class="td-leer"><b>Noch nichts offen</b>Hier steht später alles, was zu diesem Projekt gehört.</div>';
    } else {
      tdAnsicht = 'heute';
      return aufgabenAbschnitt();
    }

    return '<div class="td">' + seite + '<div class="td-inhalt">' + chips + inhalt + '</div></div>';
  }

  async function stimmeLaden() {
    try { stimme = await api('stimme'); }
    catch (fehler) { stimme = { verbunden: false, stimme: 'onyx' }; }
  }

  async function assistentLaden() {
    try { assistent = await api('assistent'); }
    catch (fehler) { assistent = { verbunden: false, hoeren: false }; }
  }

  // ---- Tagesplaner ----
  async function planLaden() {
    if (!todoist.verbunden) { planInfo = null; return; }
    try {
      const antworten = await Promise.all([api('plan'), api('plan/einstellungen')]);
      planInfo = antworten[0];
      planEinst = antworten[1];
    } catch (e) { planInfo = { fehler: e.message }; }
  }
  function planUhr(ms) {
    return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  function planTag(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
  }
  function planLeisteHtml() {
    if (!todoist.verbunden) return '';
    const p = planInfo;
    let zeile, knoepfe = '';
    if (!p) {
      zeile = 'Wird berechnet …';
    } else if (p.fehler) {
      zeile = '<span style="color:var(--sperr)">' + esc(p.fehler) + '</span>';
    } else {
      const l = p.letzteUebernahme;
      if (l && !p.aenderungen) {
        zeile = 'Geplant um ' + planUhr(l.wann) + ' Uhr' + (l.wer === 'Automatik' ? ' (automatisch)' : '')
          + ' · ' + p.bloecke.length + (p.bloecke.length === 1 ? ' Block' : ' Blöcke') + ' heute.';
      } else if (l) {
        zeile = 'Seit der Planung um ' + planUhr(l.wann) + ' Uhr hat sich etwas verschoben — '
          + '„Neu planen“ legt Offenes in die freie Zeit.';
      } else if (p.aenderungen) {
        zeile = p.bloecke.length + (p.bloecke.length === 1 ? ' Aufgabe passt' : ' Aufgaben passen') + ' heute hinein'
          + (p.verschoben.length ? ', ' + p.verschoben.length + ' kommen auf die nächsten Tage' : '')
          + (p.eingeplant && p.eingeplant.length ? ', ' + p.eingeplant.length + ' ohne Datum werden eingeplant' : '') + '.';
      } else {
        zeile = 'Nichts zu planen — alles hat seinen Platz.';
      }
      knoepfe = (p.aenderungen ? '<button class="tiny primary" data-act="plan-zeigen">' + (l ? 'Neu planen' : 'Tag planen') + '</button>' : '')
        + (l ? '<button class="tiny ghost" data-act="plan-zurueck"' + (planLaeuft ? ' disabled' : '') + '>Rückgängig</button>' : '');
    }
    return '<div class="planleiste">'
      + '<div class="planzeile"><span class="plansymbol" aria-hidden="true">◷</span><span>' + zeile
      + (planEinst && planEinst.automatisch ? ' <span class="unit-type">· plant jeden Morgen automatisch</span>' : '')
      + '</span></div>'
      + '<div class="planknoepfe">' + knoepfe
      + '<button class="tiny ghost" data-act="plan-einst" title="Arbeitszeiten und Automatik">Einstellen</button></div>'
      + '</div>';
  }
  async function planNachAenderung(meldung) {
    toast(meldung);
    await alleLaden();
    await planLaden();
    render();
  }

  async function todoistLaden() {
    try { todoist = await api('todoist'); } catch (e) { todoist = { verbunden: false, zuordnung: {} }; }
    if (todoist.verbunden) {
      try { todoistProjekte = await api('todoist/projekte'); } catch (e) { todoistProjekte = []; }
    }
  }

  // Fälligkeiten als Aufgaben nach Todoist schicken
  async function todoistSenden() {
    const aufgaben = faelligkeiten().map(function (f) {
      const o = data.objects.find(function (z) { return z.name === f.objekt; });
      return {
        schluessel: (o ? o.id : '?') + '|' + f.was + '|' + f.wann.toISOString().slice(0, 10),
        inhalt: f.was,
        beschreibung: f.objekt,
        projektId: o ? (todoist.zuordnung[o.id] || '') : '',
        faellig: f.wann.toISOString().slice(0, 10)
      };
    });
    if (!aufgaben.length) { toast('Nichts zu übertragen'); return; }
    try {
      const r = await api('todoist/sync', { method: 'POST', body: { aufgaben: aufgaben } });
      toast(r.angelegt + ' neu in Todoist' + (r.uebersprungen ? ', ' + r.uebersprungen + ' schon da' : ''));
      if (r.fehler && r.fehler.length) console.log('Todoist:', r.fehler);
    } catch (e) { toast(e.message); }
  }

  let nutzerListe = [];
  async function nutzerListeHolen() {
    try { nutzerListe = await api('users'); } catch (e) { nutzerListe = []; }
  }

  async function verlaufHolen() {
    try {
      const eintraege = await api('verlauf');
      staende = eintraege.map(function (e) {
        return { key: 'v' + e.id, id: e.id, wer: e.wer, wann: e.wann, felder: null, einheiten: null };
      });
    } catch (e) { staende = []; }
  }

  async function verlaufLaden(id) {
    try {
      const res = await api('verlauf/' + id);
      data = res.data;
      normalisieren();
      modal = null;
      await save('Stand vom ' + new Date(res.wann).toLocaleString('de-DE') + ' geladen');
      render();
    } catch (e) { toast(e.message); }
  }

  // --- Sichern und Zurückholen als Text ---
  function alsDateiSichern() {
    modal = { kind: 'sicherung' };
    render();
  }

  function herunterladenVersuchen() {
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vermietung-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast('Datei heruntergeladen');
    } catch (e) { toast('Download nicht möglich — Text kopieren'); }
  }

  function textKopieren() {
    const feld = root.querySelector('#m-json');
    if (!feld) return;
    feld.select();
    feld.setSelectionRange(0, 999999);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (ok) { toast('Kopiert'); return; }
    navigator.clipboard.writeText(feld.value)
      .then(function () { toast('Kopiert'); })
      .catch(function () { toast('Markiert — bitte mit Strg+C kopieren'); });
  }

  function textEinlesen() {
    const feld = root.querySelector('#m-jsonein');
    if (!feld || !feld.value.trim()) { toast('Da ist noch kein Text zum Einlesen'); return; }
    try {
      const geladen = JSON.parse(feld.value);
      if (!geladen || !Array.isArray(geladen.objects)) throw new Error('Format');
      data = geladen;
      normalisieren();
      modal = null;
      save('Daten eingelesen');
      render();
    } catch (e) { toast('Der Text ist keine gültige Sicherung'); }
  }

  function ausDateiLaden() {
    const eingabe = document.createElement('input');
    eingabe.type = 'file';
    eingabe.accept = '.json,.txt,application/json';
    eingabe.onchange = function () {
      const datei = eingabe.files && eingabe.files[0];
      if (!datei) return;
      const leser = new FileReader();
      leser.onload = function () {
        try {
          const geladen = JSON.parse(leser.result);
          if (!geladen || !Array.isArray(geladen.objects)) throw new Error('Format');
          data = geladen;
          normalisieren();
          modal = null;
          save('Aus Datei geladen');
          render();
        } catch (e) { toast('Die Datei ließ sich nicht lesen'); }
      };
      leser.readAsText(datei);
    };
    eingabe.click();
  }

  // Fußzeile: meldet sich nur, wenn etwas schiefging oder gerade still gespeichert wurde
  function fussInhalt() {
    if (speicherFehler) return '<span class="warnung">Letzte Änderung nicht gespeichert</span>';
    return Date.now() - gespeichertUm < 6000 ? '<span class="foot-frisch">✓ Gespeichert</span>' : '';
  }
  function fussVerblassen() {
    if (Date.now() - gespeichertUm >= 6000) return;
    setTimeout(function () {
      const f = root.querySelector('.foot-frisch');
      if (f) f.classList.add('weg');
    }, 6000 - (Date.now() - gespeichertUm));
  }
  function fussZeigen() {
    const f = root.querySelector('.foot');
    if (f) { f.innerHTML = fussInhalt(); fussVerblassen(); }
  }

  async function save(msg, erzwingen) {
    if (phase !== 'app') return;
    if (speicherLaeuft) { nochmalSpeichern = true; return; }
    speicherLaeuft = true;
    let erzwungenNochmal = false;
    try {
      // basis: der Stand, auf dem diese Änderung aufbaut. Hat inzwischen jemand
      // anderes gespeichert, lehnt der Server mit 409 ab statt still zu überschreiben.
      const res = await api('data', { method: 'PUT', body: {
        data: data, basis: zuletztGeaendert ? zuletztGeaendert.wann : null, erzwingen: !!erzwingen
      } });
      zuletztGeaendert = { wer: res.wer, wann: res.wann };
      gespeichertUm = msg ? 0 : Date.now();   // mit Meldung sagt es schon der Hinweis
      letzteSpeicher = ['Server'];
      speicherFehler = false;
      if (msg) toast(msg);
      fussZeigen();
    } catch (e) {
      letzteSpeicher = [];
      if (e.status !== 409) { speicherFehler = true; fussZeigen(); }
      if (e.status === 401) { phase = 'anmelden'; render(); toast('Bitte neu anmelden'); }
      else if (e.status === 409) {
        nochmalSpeichern = false;
        const wer = (e.inhalt && e.inhalt.wer) || 'Jemand anderes';
        const wann = e.inhalt && e.inhalt.wann ? new Date(e.inhalt.wann).toLocaleString('de-DE') : '';
        const wahl = await dialog({
          titel: wer + ' hat inzwischen gespeichert',
          text: (wann ? 'Am ' + wann + '. ' : '') + 'Du kannst den neuen Stand laden (deine letzte Änderung geht verloren) '
            + 'oder deinen Stand trotzdem speichern (die andere Änderung bleibt im Verlauf).',
          knoepfe: [{ label: 'Meinen Stand speichern', wert: 'meins' }, { label: 'Neuen Stand laden', wert: 'laden', art: 'primaer' }]
        });
        if (wahl.wert === 'meins') {
          erzwungenNochmal = true;
        } else {
          try { await datenHolen(); render(); toast('Neuer Stand geladen'); }
          catch (fehler) { toast('Laden fehlgeschlagen: ' + fehler.message); }
        }
      }
      else toast('Nicht gespeichert: ' + e.message);
    } finally {
      speicherLaeuft = false;
      if (erzwungenNochmal) save(msg, true);
      else if (nochmalSpeichern) { nochmalSpeichern = false; save(); }
    }
  }

  // Kurze Hinweise. Klingt es nach einem Fehler, bleibt er stehen, bis man ihn wegtippt (höchstens 15 s).
  const FEHLER_WORTE = /fehl|nicht |kein|antwortet|abgelehnt|abgelaufen|ungültig|zu viele|bitte|mindestens|fehlt/i;
  function toast(text, fehler) {
    if (fehler === undefined) fehler = FEHLER_WORTE.test(String(text || ''));
    const old = root.querySelector('.toast'); if (old) old.remove();
    const el = document.createElement('div'); el.className = 'toast' + (fehler ? ' fehler' : ''); el.textContent = text;
    if (fehler) {
      el.setAttribute('role', 'alert');
      el.title = 'Antippen zum Schließen';
      el.addEventListener('click', function () { el.remove(); });
    }
    root.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, fehler ? 15000 : 2600);
  }
  function fehlerToast(text) { toast(text, true); }

  const n = function (v) { return Number(v) || 0; };
  const netto = function (x) { return n(x.rent) + n(x.parking) + n(x.kitchen); };
  const brutto = function (x) { return netto(x) + n(x.nk); };
  // ---------------------------------------------------------------
  //  Stromabrechnung: Solarstrom kostet 10 % weniger als der
  //  Grundversorgungstarif, Netzstrom kostet, was der Versorger nimmt.
  //  Aufgeteilt wird nach dem Mix der gesamten Anlage.
  // ---------------------------------------------------------------
  function pvEinstellungen(o) {
    return Object.assign({
      jahr: new Date().getFullYear() - 1,
      arbeitspreis: null,     // Cent je kWh Grundversorgung
      grundpreis: null,       // Euro je Monat Grundversorgung
      netzpreis: null,        // Cent je kWh Netzstrom
      netzGrundpreis: null,   // Euro je Monat Netzstrom
      solarKwh: null,         // Jahreserzeugung der Anlage
      netzKwh: null,          // Jahresbezug aus dem Netz
      rabatt: 10              // Prozent Nachlass auf Solarstrom
    }, o.pv || {});
  }

  function stromAnteil(o) {
    const p = pvEinstellungen(o);
    const gesamt = n(p.solarKwh) + n(p.netzKwh);
    return gesamt ? n(p.solarKwh) / gesamt : 0;
  }

  function stromRechnung(o, x) {
    const p = pvEinstellungen(o);
    const anteil = stromAnteil(o);
    const verbrauch = Math.max(0, n(x.kwhEnde) - n(x.kwhStart));
    const solarKwh = verbrauch * anteil;
    const netzKwh = verbrauch - solarKwh;

    const solarPreis = n(p.arbeitspreis) * (1 - n(p.rabatt) / 100) / 100;  // Euro je kWh
    const netzPreis = n(p.netzpreis) / 100;
    const monate = n(x.monateStrom) || 12;

    const arbeitSolar = solarKwh * solarPreis;
    const arbeitNetz = netzKwh * netzPreis;
    const grundSolar = n(p.grundpreis) * (1 - n(p.rabatt) / 100) * monate * anteil;
    const grundNetz = n(p.netzGrundpreis) * monate * (1 - anteil);

    const summe = arbeitSolar + arbeitNetz + grundSolar + grundNetz;
    const gezahlt = n(x.abschlagStrom) * monate;

    return {
      verbrauch: verbrauch, anteil: anteil, solarKwh: solarKwh, netzKwh: netzKwh,
      arbeitSolar: arbeitSolar, arbeitNetz: arbeitNetz, grund: grundSolar + grundNetz,
      summe: summe, gezahlt: gezahlt, saldo: summe - gezahlt,
      neuerAbschlag: Math.ceil(summe / 12 / 5) * 5, monate: monate
    };
  }

  // ---------------------------------------------------------------
  //  Schreiben aus den gespeicherten Daten
  // ---------------------------------------------------------------
  const VORLAGEN = [
    { id: 'erhoehung', name: 'Mieterhöhung nach § 558 BGB' },
    { id: 'wgb', name: 'Wohnungsgeberbestätigung' },
    { id: 'uebergabe', name: 'Übergabeprotokoll' },
    { id: 'mahnung', name: 'Zahlungserinnerung' },
    { id: 'kuendigung', name: 'Kündigungsbestätigung' }
  ];

  function heuteText() {
    return new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function briefKopf(o, x) {
    return [
      'Michael Ziegler',
      o.name,
      '',
      x.tenant || '[Mieter]',
      o.name.split(',')[0] + ', ' + x.name,
      (o.name.split(',')[1] || '').trim(),
      '',
      heuteText(),
      ''
    ].join('\n');
  }

  function schreibenText(art, o, x) {
    const eur = function (v) { return money(v); };
    const qm = n(x.area) ? String(x.area).replace('.', ',') + ' m²' : '[Fläche]';
    const b = n(o.benchmark);

    if (art === 'erhoehung') {
      const ziel = b && n(x.area) ? Math.min(n(x.area) * b, n(x.rent) * 1.2) : n(x.rent);
      const wirksam = (function () {
        const d = new Date();
        d.setMonth(d.getMonth() + 4, 1);
        return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
      })();
      return briefKopf(o, x)
        + 'Mieterhöhung nach § 558 BGB\n\n'
        + 'Sehr geehrte Damen und Herren,\n\n'
        + 'für die von Ihnen gemietete Wohnung ' + x.name + ' in ' + o.name + ' beträgt die\n'
        + 'Nettokaltmiete derzeit ' + eur(n(x.rent)) + ' bei einer Wohnfläche von ' + qm + ',\n'
        + 'das entspricht ' + (n(x.area) ? (n(x.rent) / n(x.area)).toFixed(2).replace('.', ',') : '[…]') + ' €/m².\n\n'
        + 'Die ortsübliche Vergleichsmiete liegt laut ' + (o.mietspiegel || '[Mietspiegel]') + '\n'
        + 'bei ' + (b ? b.toFixed(2).replace('.', ',') + ' €/m²' : '[…] €/m²') + '.\n\n'
        + 'Ich erhöhe die Nettokaltmiete daher mit Wirkung zum 1. ' + wirksam + '\n'
        + 'auf ' + eur(ziel) + ' monatlich. Die Kappungsgrenze von 20 % innerhalb von drei Jahren\n'
        + 'ist eingehalten. Die Vorauszahlung für Betriebskosten bleibt mit ' + eur(n(x.nk)) + ' unverändert.\n\n'
        + 'Die neue Gesamtmiete beträgt damit ' + eur(ziel + n(x.nk) + n(x.parking) + n(x.kitchen)) + '.\n\n'
        + 'Ich bitte Sie um Ihre Zustimmung bis zum Ablauf des übernächsten Monats.\n\n'
        + 'Mit freundlichen Grüßen\n\n\nMichael Ziegler';
    }

    if (art === 'wgb') {
      return 'Wohnungsgeberbestätigung nach § 19 BMG\n\n'
        + 'Vermieter\nMichael Ziegler\n\n'
        + 'Anschrift der Wohnung\n' + o.name + '\n' + x.name + '\n\n'
        + 'Einzug am\n' + (x.movein ? dateDE(x.movein) : '[Datum]') + '\n\n'
        + 'Folgende Personen sind eingezogen\n' + (x.tenant || '[Name]') + '\n\n'
        + 'Hiermit bestätige ich den Einzug der oben genannten Personen.\n\n'
        + heuteText() + '\n\n\nUnterschrift Vermieter';
    }

    if (art === 'uebergabe') {
      return 'Wohnungsübergabeprotokoll\n\n'
        + 'Objekt: ' + o.name + '\nEinheit: ' + x.name + ' (' + qm + ')\n'
        + 'Mieter: ' + (x.tenant || '[Name]') + '\n'
        + 'Datum der Übergabe: ' + heuteText() + '\n\n'
        + 'Zählerstände\n'
        + '  Strom ' + (x.zaehler ? '(' + x.zaehler + ')' : '') + ': ______________\n'
        + '  Wasser kalt: ______________\n  Wasser warm: ______________\n  Heizung: ______________\n\n'
        + 'Schlüssel\n  Haustür: ____ Stück\n  Wohnungstür: ____ Stück\n'
        + '  Briefkasten: ____ Stück\n  Keller/Abstellraum: ____ Stück\n'
        + '  Garage/Stellplatz: ____ Stück\n\n'
        + 'Zustand der Räume\n  Küche: ________________________________\n'
        + '  Bad: __________________________________\n'
        + '  Wohnräume: ____________________________\n'
        + '  Sonstiges: ____________________________\n\n'
        + 'Mängel\n  _______________________________________\n'
        + '  _______________________________________\n\n'
        + 'Unterschriften\n\n__________________        __________________\n'
        + 'Vermieter                 Mieter';
    }

    if (art === 'mahnung') {
      const offen = kontoSaldo(x, letzteMonate(6));
      return briefKopf(o, x)
        + 'Zahlungserinnerung\n\n'
        + 'Sehr geehrte Damen und Herren,\n\n'
        + 'bei der Durchsicht meiner Unterlagen ist mir aufgefallen, dass für die Wohnung\n'
        + x.name + ' in ' + o.name.split(',')[0] + ' noch ein Betrag von\n'
        + (offen > 0 ? eur(offen) : '[Betrag]') + ' offen ist.\n\n'
        + 'Die monatliche Gesamtmiete beträgt ' + eur(brutto(x)) + ' und ist jeweils bis zum\n'
        + 'dritten Werktag des Monats fällig.\n\n'
        + 'Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es\n'
        + 'bitte als gegenstandslos. Andernfalls bitte ich um Ausgleich innerhalb von 14 Tagen.\n\n'
        + 'Mit freundlichen Grüßen\n\n\nMichael Ziegler';
    }

    if (art === 'kuendigung') {
      return briefKopf(o, x)
        + 'Bestätigung Ihrer Kündigung\n\n'
        + 'Sehr geehrte Damen und Herren,\n\n'
        + 'hiermit bestätige ich den Eingang Ihrer Kündigung für die Wohnung ' + x.name + '\n'
        + 'in ' + o.name + '.\n\n'
        + 'Das Mietverhältnis endet zum [Datum].\n\n'
        + 'Für die Wohnungsübergabe schlage ich einen Termin am [Datum] vor. Bitte denken Sie an\n'
        + 'sämtliche Schlüssel. Die Kaution in Höhe von ' + eur(kaution(x)) + ' rechne ich nach\n'
        + 'der Übergabe und der Betriebskostenabrechnung ab.\n\n'
        + 'Mit freundlichen Grüßen\n\n\nMichael Ziegler';
    }
    return '';
  }

  // ---------------------------------------------------------------
  //  Kontoauszug einlesen: CSV der Bank oder CAMT-Datei
  // ---------------------------------------------------------------
  function zahlAus(text) {
    if (text === null || text === undefined) return null;
    let t = String(text).replace(/[^0-9,.\-]/g, '').trim();
    if (!t) return null;
    // deutsches Format 1.234,56 erkennen
    if (t.indexOf(',') !== -1 && t.lastIndexOf(',') > t.lastIndexOf('.')) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(/,/g, '');
    }
    const z = Number(t);
    return isNaN(z) ? null : z;
  }

  function datumAus(text) {
    if (!text) return null;
    const m = String(text).match(/(\d{2})[.\/-](\d{2})[.\/-](\d{2,4})/);
    if (m) {
      const jahr = m[3].length === 2 ? '20' + m[3] : m[3];
      return new Date(jahr + '-' + m[2] + '-' + m[1]);
    }
    const iso = String(text).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(iso[0]);
    return null;
  }

  function csvZeilen(text) {
    const trenner = (text.split('\n')[0].match(/;/g) || []).length
      >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    return text.split(/\r?\n/).filter(Boolean).map(function (zeile) {
      const felder = [];
      let feld = '', inAnf = false;
      for (let i = 0; i < zeile.length; i++) {
        const c = zeile[i];
        if (c === '"') { inAnf = !inAnf; continue; }
        if (c === trenner && !inAnf) { felder.push(feld); feld = ''; continue; }
        feld += c;
      }
      felder.push(feld);
      return felder;
    });
  }

  function buchungenAusCsv(text) {
    const zeilen = csvZeilen(text);
    if (!zeilen.length) return [];
    const kopf = zeilen[0].map(function (h) { return h.toLowerCase(); });
    const finde = function (begriffe) {
      for (let i = 0; i < kopf.length; i++) {
        if (begriffe.some(function (b) { return kopf[i].indexOf(b) !== -1; })) return i;
      }
      return -1;
    };
    const iDatum = finde(['buchungstag', 'valuta', 'datum', 'date']);
    const iBetrag = finde(['betrag', 'amount', 'umsatz']);
    const iZweck = finde(['verwendungszweck', 'buchungstext', 'vorgang', 'beschreibung']);
    const iName = finde(['auftraggeber', 'beguenstigter', 'begünstigter', 'name', 'zahlungspflichtiger']);

    return zeilen.slice(1).map(function (z) {
      const betrag = zahlAus(iBetrag >= 0 ? z[iBetrag] : null);
      if (betrag === null || betrag <= 0) return null;      // nur Eingänge
      return {
        datum: datumAus(iDatum >= 0 ? z[iDatum] : null),
        betrag: betrag,
        text: ((iName >= 0 ? z[iName] : '') + ' ' + (iZweck >= 0 ? z[iZweck] : '')).trim()
      };
    }).filter(Boolean);
  }

  function buchungenAusCamt(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const eintraege = Array.from(doc.getElementsByTagName('Ntry'));
    return eintraege.map(function (e) {
      const holen = function (tag) {
        const el = e.getElementsByTagName(tag)[0];
        return el ? el.textContent : '';
      };
      if (holen('CdtDbtInd') !== 'CRDT') return null;        // nur Gutschriften
      const betrag = Number(holen('Amt'));
      if (!betrag) return null;
      const namen = Array.from(e.getElementsByTagName('Nm')).map(function (x) { return x.textContent; });
      return {
        datum: datumAus(holen('BookgDt') || holen('Dt')),
        betrag: betrag,
        text: (namen.join(' ') + ' ' + holen('Ustrd')).trim()
      };
    }).filter(Boolean);
  }

  function buchungenZuordnen(buchungen) {
    const ziele = [];
    data.objects.forEach(function (o) {
      o.units.forEach(function (x) {
        if (x.status !== 'vermietet') return;
        (x.tenant || '').split(',').forEach(function (name) {
          const t = name.trim().toLowerCase();
          if (t.length > 3) ziele.push({ wort: t, o: o, x: x });
        });
      });
    });

    return buchungen.map(function (b) {
      const text = (b.text || '').toLowerCase();
      const treffer = ziele.find(function (z) {
        const teile = z.wort.split(' ');
        const nachname = teile[teile.length - 1];
        return text.indexOf(z.wort) !== -1 || (nachname.length > 3 && text.indexOf(nachname) !== -1);
      });
      return {
        buchung: b,
        objekt: treffer ? treffer.o : null,
        einheit: treffer ? treffer.x : null,
        monat: b.datum ? b.datum.getFullYear() + '-' + String(b.datum.getMonth() + 1).padStart(2, '0') : null
      };
    });
  }

  // ---------------------------------------------------------------
  //  Nebenkostenabrechnung
  //  Verteilt wird nach Fläche, nach Einheiten oder nach Verbrauch.
  // ---------------------------------------------------------------
  const NK_VORLAGE = [
    { name: 'Grundsteuer', schluessel: 'flaeche' },
    { name: 'Gebäudeversicherung', schluessel: 'flaeche' },
    { name: 'Wasser und Abwasser', schluessel: 'flaeche' },
    { name: 'Müllabfuhr', schluessel: 'einheit' },
    { name: 'Straßenreinigung', schluessel: 'flaeche' },
    { name: 'Hausreinigung', schluessel: 'flaeche' },
    { name: 'Gartenpflege', schluessel: 'flaeche' },
    { name: 'Allgemeinstrom', schluessel: 'flaeche' },
    { name: 'Schornsteinfeger', schluessel: 'einheit' },
    { name: 'Aufzug', schluessel: 'flaeche' },
    { name: 'Heizung', schluessel: 'verbrauch' },
    { name: 'Hausmeister', schluessel: 'flaeche' }
  ];

  function nkDaten(o) {
    return Object.assign({ jahr: new Date().getFullYear() - 1, posten: [] }, o.nk || {});
  }

  function nkEinheiten(o) {
    return o.units.filter(function (x) {
      return parkTypes.indexOf(x.type) === -1 && x.status === 'vermietet';
    });
  }

  function nkRechnung(o) {
    const d = nkDaten(o);
    const einheiten = nkEinheiten(o);
    const flaecheGesamt = einheiten.reduce(function (a, x) { return a + n(x.area); }, 0);
    const verbrauchGesamt = einheiten.reduce(function (a, x) {
      return a + Math.max(0, n(x.kwhEnde) - n(x.kwhStart));
    }, 0);

    return einheiten.map(function (x) {
      const anteilFlaeche = flaecheGesamt ? n(x.area) / flaecheGesamt : 0;
      const anteilEinheit = einheiten.length ? 1 / einheiten.length : 0;
      const verbrauch = Math.max(0, n(x.kwhEnde) - n(x.kwhStart));
      const anteilVerbrauch = verbrauchGesamt ? verbrauch / verbrauchGesamt : anteilFlaeche;

      const zeilen = d.posten.map(function (p) {
        const anteil = p.schluessel === 'einheit' ? anteilEinheit
          : (p.schluessel === 'verbrauch' ? anteilVerbrauch : anteilFlaeche);
        return { name: p.name, gesamt: n(p.betrag), anteil: anteil, betrag: n(p.betrag) * anteil };
      });

      const summe = zeilen.reduce(function (a, z) { return a + z.betrag; }, 0);
      const gezahlt = n(x.nk) * 12;
      return {
        unit: x, zeilen: zeilen, summe: summe, gezahlt: gezahlt, saldo: summe - gezahlt,
        anteilFlaeche: anteilFlaeche, neu: Math.ceil(summe / 12 / 5) * 5
      };
    });
  }

  function nkText(o, r) {
    const d = nkDaten(o);
    const x = r.unit;
    const eur = function (v) { return money(v); };
    return [
      'Betriebskostenabrechnung ' + d.jahr,
      o.name,
      x.name + (x.tenant ? ' — ' + x.tenant : ''),
      x.area ? 'Wohnfläche ' + String(x.area).replace('.', ',') + ' m² · Anteil '
        + (r.anteilFlaeche * 100).toFixed(2).replace('.', ',') + ' %' : '',
      '',
      'Kostenart                        Gesamt        Ihr Anteil',
      '------------------------------------------------------------'
    ].concat(r.zeilen.map(function (z) {
      return (z.name + '                              ').slice(0, 30)
        + ('          ' + eur(z.gesamt)).slice(-14)
        + ('          ' + eur(z.betrag)).slice(-16);
    })).concat([
      '------------------------------------------------------------',
      ('Summe Ihrer Betriebskosten                    ').slice(0, 44) + eur(r.summe),
      ('Geleistete Vorauszahlungen (12 x ' + eur(n(x.nk)) + ')            ').slice(0, 44) + eur(r.gezahlt),
      '',
      (r.saldo >= 0 ? 'Nachzahlung' : 'Guthaben') + ': ' + eur(Math.abs(r.saldo)),
      '',
      'Ab dem kommenden Monat beträgt die Vorauszahlung ' + eur(r.neu) + '.',
      '',
      'Die Belege können nach Absprache eingesehen werden.',
      'Einwendungen sind innerhalb von zwölf Monaten nach Zugang möglich.',
      '',
      heuteText(),
      '',
      'Michael Ziegler'
    ]).join('\n');
  }

  // ---------------------------------------------------------------
  //  Prüfungen und Fristen
  // ---------------------------------------------------------------
  const PRUEF_VORLAGE = [
    { name: 'Aufzug — Hauptprüfung TÜV', intervall: 24 },
    { name: 'Aufzug — Zwischenprüfung', intervall: 12 },
    { name: 'Trinkwasser — Legionellen', intervall: 36 },
    { name: 'Rauchwarnmelder — Wartung', intervall: 12 },
    { name: 'Heizung — Wartung', intervall: 12 },
    { name: 'Schornsteinfeger', intervall: 12 },
    { name: 'Energieausweis', intervall: 120 }
  ];

  function monateDazu(datum, monate) {
    const d = new Date(datum);
    if (isNaN(d)) return null;
    d.setMonth(d.getMonth() + Number(monate || 0));
    return d;
  }

  function faelligkeiten() {
    const heute = new Date();
    const bald = new Date(); bald.setDate(bald.getDate() + 60);
    const liste = [];

    data.objects.forEach(function (o) {
      // Prüfungen
      (o.pruefungen || []).forEach(function (pr) {
        if (!pr.letzte) return;
        const naechste = monateDazu(pr.letzte, pr.intervall);
        if (!naechste || naechste > bald) return;
        liste.push({
          objekt: o.name, was: pr.name, wann: naechste,
          art: naechste < heute ? 'ueberfaellig' : 'bald'
        });
      });

      // Mietspiegel
      if (o.mietspiegelBis) {
        const bis = new Date(o.mietspiegelBis);
        if (!isNaN(bis) && bis <= bald) {
          liste.push({
            objekt: o.name, was: 'Mietspiegel läuft ab', wann: bis,
            art: bis < heute ? 'ueberfaellig' : 'bald'
          });
        }
      }

      // Mieterhöhungen
      const b = n(o.benchmark);
      if (b) {
        o.units.forEach(function (x) {
          const e = erhoehung(x, b);
          if (e.moeglich) {
            liste.push({
              objekt: o.name, was: 'Mieterhöhung möglich: ' + x.name + ' (+' + money(e.potenzial) + ')',
              wann: heute, art: 'chance'
            });
          }
        });
      }
    });

    return liste.sort(function (a, c) { return a.wann - c.wann; });
  }

  // ---------------------------------------------------------------
  //  Tagesmemo — was heute ansteht, in einer sinnvollen Reihenfolge:
  //  feste Uhrzeiten zuerst, dann Liegengebliebenes, dann Geld,
  //  dann wer auf Antwort wartet, zuletzt der Rest nach Priorität.
  //  Auf Knopfdruck liest das Gerät die Liste vor.
  // ---------------------------------------------------------------
  let memoLaeuft = false;   // wird gerade vorgelesen
  let memoWunsch = false;   // aus der Morgenmeldung geöffnet
  let planInfo = null;      // Vorschlag bzw. Stand der Tagesplanung vom Server
  let planEinst = null;     // Einstellungen des Tagesplaners
  let planLaeuft = false;   // Übernehmen oder Rückgängig läuft gerade
  let planWunsch = false;   // aus der Morgenmeldung: Vorschlag gleich öffnen
  let memoStimmeName = null;   // welche Gerätestimme vorlesen soll
  let memoAudio = null;        // laufende Aufnahme der echten Stimme
  let memoLaedt = false;       // die Aufnahme wird gerade geholt
  let stimme = { verbunden: false, stimme: 'onyx' };   // Vorlesestimme vom Server
  let assistent = { verbunden: false, hoeren: false }; // der zuhörende Assistent
  let hoert = false;          // die Aufnahme läuft gerade
  let denkt = false;          // der Assistent überlegt
  let mikro = null;           // laufende Aufnahme
  let gespraech = [];         // die letzten Wortwechsel
  let kalMonat = null;        // erster Tag des angezeigten Monats
  let kalTag = null;          // ausgewählter Tag (ISO)
  let kalSchiebt = null;      // Aufgabe, die auf einen anderen Tag soll
  // Eine Stunde in Bildpunkten — am Handy höher, damit Text in die Blöcke passt
  const KAL_HOEHE = (window.innerWidth || 1000) < 560 ? 58 : 46;
  let memoAlle = false;
  // Abgehakte Kalendertermine: stehen in den Daten, damit es auf jedem Gerät gleich aussieht
  function kalAbgehakt(k) { return !!(data && data.kalErledigt && data.kalErledigt[k]); }       // Heute: alle Punkte statt der ersten fünf
  let kalGanzAuf = false;     // Liste "ohne Uhrzeit" aufgeklappt?
  let sprichQuelle = null;    // wer gerade vorliest: 'memo' oder 'kal'
  let kalRolle = null;        // gemerkte Rollposition der Zeitachse
  let kalRolleTag = null;     // für welchen Tag sie gilt
  // Die Stimmen von OpenAI, die deutschen Ohren am besten gefallen
  const KI_STIMMEN = [
    ['onyx', 'Onyx — männlich, tief und ruhig'],
    ['ash', 'Ash — männlich, warm'],
    ['echo', 'Echo — männlich, sachlich'],
    ['ballad', 'Ballad — männlich, erzählend'],
    ['verse', 'Verse — männlich, lebendig'],
    ['alloy', 'Alloy — neutral'],
    ['sage', 'Sage — weiblich, ruhig'],
    ['coral', 'Coral — weiblich, freundlich'],
    ['nova', 'Nova — weiblich, hell'],
    ['shimmer', 'Shimmer — weiblich, weich']
  ];
  // Ein Wimpernschlag Stille: damit das iPhone beim Antippen die Tonerlaubnis erteilt
  const MEMO_STILL = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
  let memoStimmenDa = false;   // die Liste der Stimmen ist eingetroffen
  try { memoStimmeName = window.localStorage.getItem('vermietung:stimme') || null; }
  catch (fehler) { memoStimmeName = null; }

  function memoZeit(stempel) {
    if (!stempel || String(stempel).indexOf('T') === -1) return '';
    const d = new Date(stempel);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function memoGross(s) {
    s = String(s || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // Mieten des laufenden Monats und Rückstand der letzten sechs Monate
  function memoMieten() {
    const md = new Date();
    const schluessel = md.getFullYear() + '-' + String(md.getMonth() + 1).padStart(2, '0');
    const monate6 = letzteMonate(6);
    let offenAnzahl = 0, offenSumme = 0, rueckstand = 0;
    (data.objects || []).forEach(function (o) {
      (o.units || []).forEach(function (x) {
        if (x.status !== 'vermietet' || !soll(x)) return;
        const betrag = Math.round(soll(x) * 100) / 100;
        const gezahlt = (x.zahlungen && x.zahlungen[schluessel] != null) ? n(x.zahlungen[schluessel]) : null;
        if (gezahlt == null || gezahlt < betrag - 0.005) {
          offenAnzahl++;
          offenSumme += betrag - Math.max(0, n(gezahlt));
        }
        rueckstand += Math.max(0, kontoSaldo(x, monate6));
      });
    });
    return { offenAnzahl: offenAnzahl, offenSumme: offenSumme, rueckstand: rueckstand, tag: md.getDate() };
  }

  function memoPunkte() {
    const heuteIso = heuteISO();
    const alle = alleAufgaben || [];
    const punkte = [];

    // 1 — alles mit fester Uhrzeit, chronologisch
    (data.interessenten || []).filter(function (i) {
      return i.status !== 'absage' && terminHeute(i.termin);
    }).forEach(function (i) {
      const zeit = i.termin.length > 10 ? i.termin.slice(11, 16) : '';
      punkte.push({
        rang: 1, sort: zeit || '00:00', zeit: zeit,
        was: 'Besichtigung' + (i.name ? ' mit ' + i.name : ''),
        wo: einheitKurz(i.einheitId) || istatusName(i.status),
        warum: 'fester Termin — daran hängt jemand',
        act: 'interessent-oeffnen', id: i.id
      });
    });
    alle.filter(function (t) { return t.faellig === heuteIso && memoZeit(t.faelligZeit); })
      .forEach(function (t) {
        const zeit = memoZeit(t.faelligZeit);
        punkte.push({
          rang: 1, sort: zeit, zeit: zeit, was: t.inhalt,
          wo: tdProjektName(t.projektId), warum: 'hat eine feste Uhrzeit', tid: t.id
        });
      });

    // 2 — liegengeblieben: überfällige Aufgaben und abgelaufene Fristen
    alle.filter(function (t) { return t.faellig && t.faellig < heuteIso; })
      .forEach(function (t) {
        const tage = Math.max(1, Math.round((tdHeute() - tdTag(t.faellig)) / 86400000));
        punkte.push({
          rang: 2, sort: t.faellig, zeit: '', was: t.inhalt,
          wo: tdProjektName(t.projektId),
          warum: tdWartet(t) ? 'nachfassen — wartet seit ' + tage + (tage === 1 ? ' Tag' : ' Tagen') + ' auf Antwort'
            : 'liegt seit ' + tage + (tage === 1 ? ' Tag' : ' Tagen') + ' — wird nicht besser',
          tid: t.id, rot: true
        });
      });
    faelligkeiten().filter(function (f) { return f.art === 'ueberfaellig'; }).forEach(function (f) {
      punkte.push({
        rang: 2, sort: 'zz', zeit: '', was: f.was,
        wo: String(f.objekt || '').split(',')[0],
        warum: 'die Frist ist abgelaufen', rot: true
      });
    });

    // 3 — Geld: Rückstand vor laufendem Monat
    const m = memoMieten();
    if (m.rueckstand > 0.5) {
      punkte.push({
        rang: 3, sort: 'a', zeit: '', was: money(m.rueckstand) + ' Rückstand nachfassen',
        wo: 'Mieten', warum: 'Geld, das dir gehört', act: 'zu-mieten', rot: true
      });
    } else if (m.offenAnzahl && m.tag >= 5) {
      punkte.push({
        rang: 3, sort: 'b', zeit: '',
        was: m.offenAnzahl + (m.offenAnzahl === 1 ? ' Miete' : ' Mieten') + ' noch nicht abgehakt',
        wo: money(m.offenSumme) + ' aussen',
        warum: 'Kontoauszug ansehen und eintragen', act: 'zu-mieten'
      });
    }

    // 4 — wer auf dich wartet
    const neue = (data.interessenten || []).filter(function (i) { return i.status === 'neu'; });
    if (neue.length) {
      punkte.push({
        rang: 4, sort: 'a', zeit: '',
        was: neue.length + (neue.length === 1 ? ' Anfrage' : ' Anfragen') + ' beantworten',
        wo: neue.length === 1 ? (neue[0].name || 'Interessent') : 'Interessenten',
        warum: 'wer schnell antwortet, hat die Auswahl', act: 'zu-interessenten'
      });
    }

    // 5 — der Rest von heute, nach Priorität
    alle.filter(function (t) { return t.faellig === heuteIso && !memoZeit(t.faelligZeit); })
      .sort(function (a, c) { return (c.prioritaet || 1) - (a.prioritaet || 1); })
      .forEach(function (t) {
        const p = t.prioritaet || 1;
        punkte.push({
          rang: 5, sort: String(5 - p), zeit: '', was: t.inhalt,
          wo: tdProjektName(t.projektId),
          warum: tdWartet(t) ? 'heute nachfassen — wartet auf Antwort'
            : (p >= 4 ? 'als wichtig markiert' : (p === 3 ? 'heute eingeplant' : 'für heute vorgemerkt')),
          tid: t.id
        });
      });

    punkte.sort(function (a, c) {
      return a.rang - c.rang || (a.sort < c.sort ? -1 : (a.sort > c.sort ? 1 : 0));
    });
    return punkte;
  }

  // Der gesprochene Text — Satz für Satz, damit die Ausgabe nicht abbricht
  function memoSprechtext() {
    const jetzt = new Date();
    const stunde = jetzt.getHours();
    const datum = jetzt.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    const gruss = stunde < 11 ? 'Guten Morgen.' : (stunde < 18 ? 'Hallo.' : 'Guten Abend.');
    const punkte = memoPunkte();
    const saetze = [gruss + ' Heute ist ' + datum + '.'];
    if (!punkte.length) {
      saetze.push('Es steht nichts Dringendes an. Ein guter Tag zum Aufräumen.');
      return saetze;
    }
    saetze.push('Es stehen ' + punkte.length + (punkte.length === 1 ? ' Sache an.' : ' Sachen an.'));
    const woerter = ['Zuerst', 'Danach', 'Als Drittes', 'Als Viertes', 'Als Fünftes',
      'Als Sechstes', 'Als Siebtes', 'Als Achtes'];
    punkte.slice(0, 8).forEach(function (p, i) {
      let satz = (woerter[i] || 'Dann') + ': ';
      if (p.zeit) satz += 'um ' + p.zeit.replace(':', ' Uhr ').replace(/ 00$/, '') + ', ';
      // Trennzeichen wie „·" würden mitgesprochen — daraus werden Pausen
      const wo = String(p.wo || '').replace(/\s*[·|]\s*/g, ', ');
      satz += p.was + (wo ? ', ' + wo : '') + '. ' + memoGross(p.warum) + '.';
      saetze.push(satz);
    });
    if (punkte.length > 8) {
      saetze.push('Dazu kommen noch ' + (punkte.length - 8) + ' Kleinigkeiten im Tagesplan.');
    }
    saetze.push('Das war alles. Viel Erfolg.');
    return saetze;
  }

  // Bekannte männliche deutsche Stimmen auf Handy, Tablet und PC
  const MEMO_MAENNLICH = /markus|martin|stefan|conrad|yannick|viktor|klaus|hans|bernd|ralf|florian|christoph|jonas|niklas|male|männlich|mann|[-_ ](b|d|h)\b|wavenet-b|neural2-b|standard-b/i;
  // Stimmen, die deutlich natürlicher klingen als die alten Ansagestimmen
  const MEMO_GUT = /premium|enhanced|natural|neural|wavenet|journey|studio|online|siri|google/i;

  function memoNote(v) {
    let note = 0;
    if (MEMO_MAENNLICH.test(v.name)) note += 4;
    if (MEMO_GUT.test(v.name)) note += 2;
    if (v.localService === false) note += 1;   // Netzstimmen klingen meist runder
    return note;
  }

  // Alle deutschen Stimmen des Geräts, die beste zuerst
  function memoStimmen() {
    try {
      const alle = window.speechSynthesis.getVoices() || [];
      const deutsch = alle.filter(function (v) { return /^de/i.test(v.lang); });
      return (deutsch.length ? deutsch : alle).slice().sort(function (a, c) {
        return memoNote(c) - memoNote(a) || a.name.localeCompare(c.name, 'de');
      });
    } catch (fehler) { return []; }
  }

  function memoStimme() {
    const liste = memoStimmen();
    if (!liste.length) return null;
    if (memoStimmeName) {
      const gewaehlt = liste.find(function (v) { return v.name === memoStimmeName; });
      if (gewaehlt) return gewaehlt;
    }
    return liste[0];
  }

  function memoStimmeMerken(name) {
    memoStimmeName = name || null;
    try { window.localStorage.setItem('vermietung:stimme', memoStimmeName || ''); }
    catch (fehler) { /* ohne Speicher gilt die Wahl nur für diese Sitzung */ }
  }

  // Kurze Hörprobe, damit man die Stimme sofort beurteilen kann
  const MEMO_PROBETEXT = 'So klingt es. Guten Morgen, Louis — heute stehen drei Sachen an. '
    + 'Zuerst: um neun Uhr der Handwerker wegen der Heizung.';

  // Einen beliebigen Satz aussprechen — mit der echten Stimme, sonst mit der des Geräts
  function memoSagen(text) {
    if (!text) return;
    if (stimme.verbunden) {
      fetch('/api/stimme/sprechen', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      }).then(function (antwort) {
        if (!antwort.ok) return antwort.json().then(function (g) { throw new Error(g.fehler || 'Fehler'); });
        return antwort.blob();
      }).then(function (ton) {
        if (!memoAudio) memoAudio = new Audio();
        memoAudio.src = URL.createObjectURL(ton);
        return memoAudio.play();
      }).catch(function (fehler) { toast(fehler.message); });
      return;
    }
    if (!('speechSynthesis' in window)) return;
    const satz = new SpeechSynthesisUtterance(text);
    satz.lang = 'de-DE';
    satz.rate = 0.95;
    const stimmwahl = memoStimme();
    if (stimmwahl) satz.voice = stimmwahl;
    try { window.speechSynthesis.speak(satz); } catch (fehler) { /* egal */ }
  }

  // Der Fingertipp erlaubt den Ton — das nutzen wir, bevor die Antwort da ist
  function tonFreischalten() {
    try {
      memoAudio = new Audio(MEMO_STILL);
      memoAudio.play().catch(function () { /* egal */ });
    } catch (fehler) { memoAudio = null; }
  }

  function memoProbe() {
    memoStopp(true);
    if (stimme.verbunden) {
      tonFreischalten();
      memoSagen(MEMO_PROBETEXT);
      return;
    }
    if (!('speechSynthesis' in window)) return;
    const s = new SpeechSynthesisUtterance(MEMO_PROBETEXT);
    s.lang = 'de-DE';
    s.rate = 0.95;
    const gewaehlt = memoStimme();
    if (gewaehlt) s.voice = gewaehlt;
    try { window.speechSynthesis.speak(s); } catch (fehler) { /* egal */ }
  }

  // ---- Zuhören: aufnehmen, verstehen lassen, eintragen ----
  async function zuhoeren() {
    if (hoert) { aufnahmeBeenden(); return; }
    if (denkt) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast('Dieses Gerät kann nicht aufnehmen — tipp deinen Auftrag ins Feld darunter.');
      return;
    }
    memoStopp(true);
    tonFreischalten();          // damit die Antwort später klingen darf
    try {
      const spur = await navigator.mediaDevices.getUserMedia({ audio: true });
      const stuecke = [];
      mikro = new MediaRecorder(spur);
      mikro.ondataavailable = function (ev) { if (ev.data && ev.data.size) stuecke.push(ev.data); };
      mikro.onstop = function () {
        try { spur.getTracks().forEach(function (t) { t.stop(); }); } catch (fehler) { /* egal */ }
        const ton = new Blob(stuecke, { type: (mikro && mikro.mimeType) || 'audio/webm' });
        hoert = false;
        if (!ton.size) { render(); return; }
        denkt = true; render();
        assistentFragen(ton);
      };
      mikro.start();
      hoert = true; render();
    } catch (fehler) {
      toast('Kein Zugriff aufs Mikrofon — bitte in den Einstellungen des Browsers erlauben.');
    }
  }

  function aufnahmeBeenden() {
    try { if (mikro && mikro.state !== 'inactive') mikro.stop(); }
    catch (fehler) { hoert = false; render(); }
  }

  function gespraechVerlauf() {
    return gespraech.slice(-6).map(function (z) {
      return { role: z.wer === 'ich' ? 'user' : 'assistant', content: z.text };
    });
  }

  async function assistentFragen(ton) {
    try {
      const gehoert = await fetch('/api/assistent/hoeren', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': ton.type || 'audio/webm' },
        body: ton
      });
      if (!gehoert.ok) {
        let grund = null;
        try { grund = await gehoert.json(); } catch (fehler) { grund = null; }
        throw new Error((grund && grund.fehler) || 'Ich habe nichts verstanden');
      }
      const verstanden = (await gehoert.json()).text;
      if (!verstanden) { denkt = false; render(); toast('Da war nichts zu hören.'); return; }
      await assistentSenden(verstanden);
    } catch (fehler) {
      denkt = false; render(); toast(fehler.message);
    }
  }

  async function assistentSenden(text) {
    const verlauf = gespraechVerlauf();
    gespraech.push({ wer: 'ich', text: text });
    denkt = true; render();
    try {
      const antwort = await fetch('/api/assistent/sagen', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, verlauf: verlauf })
      });
      const ergebnis = await antwort.json();
      if (!antwort.ok) throw new Error(ergebnis.fehler || 'Der Assistent antwortet nicht');
      gespraech.push({ wer: 'du', text: ergebnis.antwort });
      denkt = false; render();
      memoSagen(ergebnis.antwort);
      if (ergebnis.getan && ergebnis.getan.length) {
        alleLaden().then(function () { render(); });
      }
    } catch (fehler) {
      denkt = false; render(); toast(fehler.message);
    }
  }

  function memoStopp(stillt) {
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (fehler) { /* egal */ }
    try { if (memoAudio) { memoAudio.pause(); memoAudio.currentTime = 0; } } catch (fehler) { /* egal */ }
    const lief = memoLaeuft || memoLaedt;
    memoLaeuft = false; memoLaedt = false; sprichQuelle = null;
    if (lief && !stillt) render();
  }

  function memoVorlesen() {
    if (memoLaeuft || memoLaedt) { memoStopp(); return; }
    sprichQuelle = 'memo';

    // Mit eingerichteter Vorlesestimme klingt es wie ein Mensch — sonst spricht das Gerät
    if (stimme.verbunden) {
      // Sofort ein Fitzelchen Stille abspielen, solange der Fingertipp noch zählt:
      // danach darf dasselbe Element auch die fertige Aufnahme abspielen (iPhone).
      try {
        if (memoAudio && memoAudio.src && memoAudio.src.indexOf('blob:') === 0) URL.revokeObjectURL(memoAudio.src);
        memoAudio = new Audio(MEMO_STILL);
        memoAudio.play().catch(function () { /* egal */ });
      } catch (fehler) { memoAudio = null; }
      memoEchteStimme(memoSprechtext().join(' '));
      return;
    }
    memoGeraetestimme(memoSprechtext());
  }

  async function memoEchteStimme(text) {
    memoLaedt = true; memoLaeuft = true; memoWunsch = false; render();
    try {
      const antwort = await fetch('/api/stimme/sprechen', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });
      if (!antwort.ok) {
        let grund = null;
        try { grund = await antwort.json(); } catch (fehler) { grund = null; }
        throw new Error((grund && grund.fehler) || ('Fehler ' + antwort.status));
      }
      const ton = await antwort.blob();
      if (!memoLaedt) return;   // inzwischen gestoppt — Aufnahme verwerfen
      const adresse = URL.createObjectURL(ton);
      if (!memoAudio) memoAudio = new Audio();
      memoAudio.src = adresse;
      memoAudio.onended = function () { memoLaeuft = false; sprichQuelle = null; render(); };
      memoAudio.onerror = function () { memoLaeuft = false; memoLaedt = false; sprichQuelle = null; render(); };
      memoLaedt = false; render();
      await memoAudio.play();
    } catch (fehler) {
      memoLaedt = false; memoLaeuft = false; render();
      toast(fehler.message + ' — ich nehme die Gerätestimme.');
      memoGeraetestimme();
    }
  }

  function memoGeraetestimme(saetze) {
    if (!('speechSynthesis' in window)) {
      toast('Dieses Gerät kann nicht vorlesen — der Text steht aber oben.');
      return;
    }
    try { window.speechSynthesis.cancel(); } catch (fehler) { /* egal */ }
    memoLaeuft = true; memoWunsch = false; render();
    const gewaehlt = memoStimme();
    saetze.forEach(function (satz, i) {
      const s = new SpeechSynthesisUtterance(satz);
      s.lang = 'de-DE';
      s.rate = 0.95;
      if (gewaehlt) s.voice = gewaehlt;
      s.onerror = function () { memoLaeuft = false; sprichQuelle = null; render(); };
      if (i === saetze.length - 1) s.onend = function () { memoLaeuft = false; sprichQuelle = null; render(); };
      try { window.speechSynthesis.speak(s); } catch (fehler) { memoLaeuft = false; }
    });
  }

  // Uhrzeit in gesprochene Worte: 540 -> "9 Uhr", 570 -> "9 Uhr 30"
  function kalUhrWort(minuten) {
    const st = Math.floor(minuten / 60), mi = minuten % 60;
    return st + ' Uhr' + (mi ? ' ' + String(mi).padStart(2, '0') : '');
  }

  // Der gewählte Kalendertag als Sätze zum Vorlesen
  function kalSprechtext() {
    const heuteIso = heuteISO();
    const iso = kalTag || heuteIso;
    const belegung = kalBelegung();
    const tages = kalTagListe(iso, belegung);
    const zeitplan = kalZeitplan(iso, belegung);
    const tag = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
    const tagName = tag.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    const putz = function (t) { return String(t || '').replace(/\s*[·|]\s*/g, ', '); };

    const saetze = [];
    saetze.push((iso === heuteIso ? 'Dein Kalender für heute, ' : 'Dein Kalender für ') + tagName + '.');

    const planOhne = tages.aufgaben.filter(function (t) { return !t.faelligZeit; });
    const ganzeGkal = tages.gtermine.filter(function (g) { return g.ganztags; });
    const liegen = iso === heuteIso
      ? (alleAufgaben || []).filter(function (t) { return t.faellig && t.faellig < heuteIso; })
      : [];

    if (!zeitplan.length && !planOhne.length && !tages.fristen.length && !liegen.length && !ganzeGkal.length) {
      saetze.push('An diesem Tag ist nichts eingetragen.');
      return saetze;
    }

    if (zeitplan.length) {
      saetze.push(zeitplan.length === 1 ? 'Ein Eintrag mit Uhrzeit.' : zeitplan.length + ' Einträge mit Uhrzeit.');
      zeitplan.slice(0, 12).forEach(function (e) {
        const wann = e.echteDauer
          ? 'Von ' + kalUhrWort(e.von) + ' bis ' + kalUhrWort(e.von + e.dauer)
          : 'Um ' + kalUhrWort(e.von);
        const wo = (e.unten && e.unten !== 'Kalender') ? ', ' + putz(e.unten) : '';
        saetze.push(wann + ': ' + putz(e.titel) + wo + '.');
      });
      if (zeitplan.length > 12) saetze.push('Und ' + (zeitplan.length - 12) + ' weitere mit Uhrzeit.');
    }

    tages.fristen.forEach(function (f) { saetze.push('Frist: ' + putz(f.was) + '.'); });
    if (liegen.length) {
      saetze.push('Liegengeblieben: ' + liegen.slice(0, 5).map(function (t) { return putz(t.inhalt); }).join(', ')
        + (liegen.length > 5 ? ', und ' + (liegen.length - 5) + ' weitere' : '') + '.');
    }
    if (planOhne.length) {
      saetze.push('Ohne Uhrzeit: ' + planOhne.slice(0, 6).map(function (t) { return putz(t.inhalt); }).join(', ')
        + (planOhne.length > 6 ? ', und ' + (planOhne.length - 6) + ' weitere' : '') + '.');
    }
    ganzeGkal.forEach(function (g) { saetze.push('Ganztägig: ' + putz(g.titel) + '.'); });
    saetze.push('Das war der Tag.');
    return saetze;
  }

  function kalVorlesen() {
    if (memoLaeuft || memoLaedt) { memoStopp(); return; }
    sprichQuelle = 'kal';
    if (stimme.verbunden) {
      try {
        if (memoAudio && memoAudio.src && memoAudio.src.indexOf('blob:') === 0) URL.revokeObjectURL(memoAudio.src);
        memoAudio = new Audio(MEMO_STILL);
        memoAudio.play().catch(function () { /* egal */ });
      } catch (fehler) { memoAudio = null; }
      memoEchteStimme(kalSprechtext().join(' '));
      return;
    }
    memoGeraetestimme(kalSprechtext());
  }

  // ---------------------------------------------------------------
  //  Kalender — der Monat auf einen Blick, ein Tag zum Bearbeiten
  // ---------------------------------------------------------------
  function kalIso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Was an welchem Tag ansteht — einmal je Anzeige gesammelt
  function kalBelegung() {
    const karte = {};
    const nimm = function (iso) {
      if (!karte[iso]) karte[iso] = { aufgaben: [], termine: [], fristen: [], gtermine: [] };
      return karte[iso];
    };
    (alleAufgaben || []).forEach(function (t) {
      if (t.faellig) nimm(t.faellig).aufgaben.push(t);
    });
    (data.interessenten || []).forEach(function (i) {
      if (i.status !== 'absage' && i.termin) nimm(i.termin.slice(0, 10)).termine.push(i);
    });
    (gkalListe || []).forEach(function (g) {
      if (g.tag) nimm(g.tag).gtermine.push(g);
    });
    faelligkeiten().forEach(function (f) {
      if (f.wann) nimm(kalIso(f.wann)).fristen.push(f);
    });
    return karte;
  }

  function kalTagListe(iso, belegung) {
    const b = belegung[iso] || { aufgaben: [], termine: [], fristen: [], gtermine: [] };
    return {
      aufgaben: b.aufgaben.slice().sort(function (a, c) {
        const az = a.faelligZeit ? 0 : 1, cz = c.faelligZeit ? 0 : 1;
        return az - cz || (c.prioritaet || 1) - (a.prioritaet || 1);
      }),
      termine: b.termine.slice().sort(function (a, c) { return a.termin < c.termin ? -1 : 1; }),
      gtermine: b.gtermine.slice().sort(function (a, c) { return a.start < c.start ? -1 : 1; }),
      fristen: b.fristen
    };
  }

  // Alles mit Uhrzeit, umgerechnet in Minuten seit Mitternacht
  function kalZeitplan(iso, belegung) {
    const b = belegung[iso] || { aufgaben: [], termine: [], fristen: [], gtermine: [] };
    const liste = [];
    b.termine.forEach(function (i) {
      if (i.termin.length <= 10) return;
      const von = Number(i.termin.slice(11, 13)) * 60 + Number(i.termin.slice(14, 16));
      liste.push({
        art: 'termin', von: von, dauer: 45,
        titel: 'Besichtigung' + (i.name ? ' mit ' + i.name : ''),
        unten: einheitKurz(i.einheitId) || '',
        act: 'interessent-oeffnen', id: i.id
      });
    });
    b.aufgaben.forEach(function (t) {
      if (!t.faelligZeit) return;
      const d = new Date(t.faelligZeit);
      if (isNaN(d)) return;
      liste.push({
        art: 'aufgabe', von: d.getHours() * 60 + d.getMinutes(), dauer: t.dauer || 60,
        titel: t.inhalt, unten: tdProjektName(t.projektId),
        act: 'td-oeffnen', tid: t.id
      });
    });

    // Google-Termine dazu — steht dieselbe Sache schon als Aufgabe drin
    // (gleicher Titel, etwa gleiche Zeit), wird nichts doppelt gezeigt:
    // die Aufgabe bleibt (abhakbar) und übernimmt die echte Dauer des Termins.
    const glatt = function (t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
    const worte = function (t) {
      return glatt(t).replace(/[()\[\]{}.,:;!?"'\/\\+\-–—]/g, ' ')
        .split(/\s+/).filter(function (w) { return w.length > 2; });
    };
    // Gleiche Sache, anders formuliert? Zählt, wie viele Worte sich decken.
    const gleicheSache = function (a, c) {
      const wa = worte(a), wc = worte(c);
      if (!wa.length || !wc.length) return glatt(a) === glatt(c);
      const kurz = wa.length <= wc.length ? wa : wc;
      const lang = wa.length <= wc.length ? wc : wa;
      const drin = {};
      lang.forEach(function (w) { drin[w] = 1; });
      const treffer = kurz.filter(function (w) { return drin[w]; }).length;
      return treffer >= Math.max(1, Math.ceil(kurz.length * 0.7));
    };
    b.gtermine.forEach(function (g) {
      if (g.ganztags) return;
      const von = Number(g.start.slice(11, 13)) * 60 + Number(g.start.slice(14, 16));
      let dauer = 45;
      if (g.ende && g.ende.slice(0, 10) === g.tag) {
        dauer = Number(g.ende.slice(11, 13)) * 60 + Number(g.ende.slice(14, 16)) - von;
      } else if (g.ende) {
        dauer = 24 * 60 - von;   // läuft über Mitternacht hinaus
      }
      dauer = Math.max(20, dauer);
      const zwilling = liste.find(function (e) {
        return e.art === 'aufgabe' && !e.verschmolzen
          && Math.abs(e.von - von) <= 15 && gleicheSache(e.titel, g.titel);
      });
      if (zwilling) {
        zwilling.von = von;
        zwilling.dauer = dauer;
        zwilling.verschmolzen = true;
        zwilling.echteDauer = true;
        return;
      }
      liste.push({
        art: 'gtermin', von: von, dauer: dauer, echteDauer: true,
        titel: g.titel, unten: g.ort || 'Kalender',
        act: 'gkal-info', id: g.id
      });
    });
    liste.sort(function (a, c) { return a.von - c.von || (c.dauer - a.dauer); });

    // Überschneidungen: bis zu zwei nebeneinander, ab drei versetzt gestapelt
    let gruppe = [], ende = -1;
    const fertig = [];
    liste.forEach(function (e) {
      if (e.von >= ende && gruppe.length) { fertig.push(gruppe); gruppe = []; }
      gruppe.push(e);
      ende = Math.max(ende, e.von + e.dauer);
    });
    if (gruppe.length) fertig.push(gruppe);
    fertig.forEach(function (g) {
      g.forEach(function (e, i) { e.spalte = i; e.spalten = g.length; });
    });
    return liste;
  }

  // Aufgabe auf eine Uhrzeit legen (heute oder gewählter Tag) — der Server trägt sie auch in den Kalender „Aufgaben“ ein
  function tdUhrzeitSetzen(tid, datum, hhmm) {
    const t = tdFinde(tid); if (!t) return;
    tdMenue = null;
    const alt = { faellig: t.faellig, zeit: t.faelligZeit };
    t.faellig = datum; t.faelligZeit = datum + 'T' + hhmm + ':00'; tdAbleiten(); render();
    api('todoist/aufgabe/' + encodeURIComponent(tid), { method: 'POST', body: { faelligZeit: datum + 'T' + hhmm + ':00' } })
      .then(function () { toast('„' + tdKurz(t.inhalt, 30) + '“ um ' + hhmm + ' eingeplant'); return alleLaden(); })
      .then(function () { render(); })
      .catch(function (e) { toast(e.message); t.faellig = alt.faellig; t.faelligZeit = alt.zeit; tdAbleiten(); render(); });
  }
  // Wartet auf Antwort: Label dazu, Datum = Nachfass-Tag
  function tdWartenSetzen(tid, tage) {
    const t = tdFinde(tid); if (!t) return;
    tdMenue = null;
    const label = tdWartetLabel();
    const labels = (t.labels || []).filter(function (l) { return !WARTET_MUSTER.test(l); }).concat([label]);
    const datum = tdIso(tdPlus(tage));
    const alt = { labels: t.labels, faellig: t.faellig, zeit: t.faelligZeit };
    t.labels = labels; t.faellig = datum; t.faelligZeit = null; tdAbleiten(); render();
    api('todoist/aufgabe/' + encodeURIComponent(tid), { method: 'POST', body: { labels: labels, faellig: datum } })
      .then(function () {
        toastAktion('Wartet — nachfassen ' + planTag(datum), 'Rückgängig', function () {
          api('todoist/aufgabe/' + encodeURIComponent(tid), { method: 'POST', body: { labels: alt.labels || [], faellig: alt.faellig || '' } })
            .then(function () { return alleLaden(); }).then(function () { render(); });
        });
        return alleLaden();
      })
      .then(function () { render(); })
      .catch(function (e) { toast(e.message); Object.assign(t, { labels: alt.labels, faellig: alt.faellig, faelligZeit: alt.zeit }); tdAbleiten(); render(); });
  }
  function tdWartenEnde(tid) {
    const t = tdFinde(tid); if (!t) return;
    tdMenue = null;
    const labels = (t.labels || []).filter(function (l) { return !WARTET_MUSTER.test(l); });
    t.labels = labels; t.faellig = heuteISO(); t.faelligZeit = null; tdAbleiten(); render();
    api('todoist/aufgabe/' + encodeURIComponent(tid), { method: 'POST', body: { labels: labels, faellig: heuteISO() } })
      .then(function () { toast('Antwort ist da — steht wieder auf heute'); return alleLaden(); })
      .then(function () { render(); })
      .catch(function (e) { toast(e.message); });
  }
  // Verlauf: „25.09. Text“ unten an die Beschreibung hängen
  function verlaufAnhaengen(besch, text) {
    const d = new Date();
    const zeile = String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '. ' + text.trim();
    const b = String(besch || '').replace(/\s+$/, '');
    if (/(^|\n)Verlauf:?\s*(\n|$)/i.test(b)) return b + '\n' + zeile;
    return (b ? b + '\n\n' : '') + 'Verlauf:\n' + zeile;
  }
  async function verlaufEintragen() {
    const feld = root.querySelector('#t-verlauf');
    if (!feld || !feld.value.trim() || !modal || modal.kind !== 'aufgabe') return;
    modalEntwurfMerken();
    const t = modal.aufgabe;
    const e = modal.entwurf || {};
    const alt = e.beschreibung !== undefined ? e.beschreibung : (t.beschreibung || '');
    const neu = verlaufAnhaengen(alt, feld.value);
    try {
      await api('todoist/aufgabe/' + encodeURIComponent(t.id), { method: 'POST', body: { beschreibung: neu } });
      const echt = tdFinde(t.id); if (echt) echt.beschreibung = neu;
      if (modal.entwurf) modal.entwurf.beschreibung = neu;
      // Beim Neuaufbau werden die Felder ausgelesen — deshalb auch direkt ins Feld schreiben
      const tb = root.querySelector('#t-besch'); if (tb) tb.value = neu;
      const tv = root.querySelector('#t-verlauf'); if (tv) tv.value = '';
      modal.verlaufText = '';
      toast('Im Verlauf eingetragen');
      render();
    } catch (x) { toast(x.message); }
  }
  // Diktieren mit der Spracherkennung des Browsers (Chrome, Edge, Safari)
  function verlaufDiktieren() {
    const Erkennung = window.SpeechRecognition || window.webkitSpeechRecognition;
    const feld = root.querySelector('#t-verlauf');
    if (!Erkennung || !feld) { toast('Dein Browser kann nicht diktieren — bitte tippen'); return; }
    const r = new Erkennung();
    r.lang = 'de-DE'; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = function (ev) {
      const text = ev.results[0][0].transcript;
      feld.value = (feld.value ? feld.value + ' ' : '') + text;
      feld.focus();
    };
    r.onerror = function () { toast('Nicht verstanden — bitte nochmal'); };
    r.start();
    toast('Ich höre zu …');
  }

  function kalSchiebenAuf(iso) {
    const tid = kalSchiebt;
    kalSchiebt = null;
    kalTag = iso;
    tdDatumSetzen(tid, iso);
  }

  // ---------------------------------------------------------------
  //  Interessenten — Bewerber je Wohnung, vom ersten Kontakt bis zur Zusage
  // ---------------------------------------------------------------
  const ISTATUS = [
    ['neu', 'Angefragt'], ['besichtigung', 'Besichtigung'],
    ['auskunft', 'Selbstauskunft'], ['zusage', 'Zusage'], ['absage', 'Absage']
  ];
  const IFOLGE = { neu: 'besichtigung', besichtigung: 'auskunft', auskunft: 'zusage' };

  function interessentNeu(v) {
    return Object.assign({
      id: 'i' + Math.random().toString(36).slice(2, 9),
      name: '', kontakt: '', einheitId: '', status: 'neu',
      termin: '', notiz: '', quelle: '',
      angelegt: heuteISO()
    }, v || {});
  }
  function heuteISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
  function istatusName(st) {
    const t = ISTATUS.find(function (z) { return z[0] === st; });
    return t ? t[1] : st;
  }
  function einheitInfo(id) {
    if (!id) return null;
    const t = allUnits().find(function (z) { return z.u.id === id; });
    return t ? { o: t.o, x: t.u } : null;
  }
  function einheitKurz(id) {
    const t = einheitInfo(id);
    return t ? t.o.name.split(',')[0] + ' · ' + t.x.name : '';
  }
  function interessentVon(id) {
    return (data.interessenten || []).find(function (i) { return i.id === id; });
  }
  function terminHeute(t) { return !!t && t.slice(0, 10) === heuteISO(); }
  function terminText(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return t;
    const zeit = t.length > 10 ? ' ' + t.slice(11, 16) : '';
    if (terminHeute(t)) return 'heute' + zeit;
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + zeit;
  }

  // ---------------------------------------------------------------
  //  Mitteilungen: dieses Gerät beim Server anmelden
  // ---------------------------------------------------------------
  function pushKann() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function pushIosHinweis() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const installiert = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    return ios && !installiert;
  }
  function geraetName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows-PC';
    return 'Browser';
  }
  function b64ZuBytes(text) {
    const auffuellung = '='.repeat((4 - text.length % 4) % 4);
    const roh = window.atob((text + auffuellung).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(roh.length);
    for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
    return bytes;
  }
  function wennPushOffen() { if (modal && modal.kind === 'push') render(); }
  function pushModalLaden() {
    api('push/geraete').then(function (g) { pushGeraete = g; wennPushOffen(); })
      .catch(function (e) { pushGeraete = []; pushFehler = e.message; wennPushOffen(); });
    api('push/einstellungen').then(function (e) { pushEinst = e; wennPushOffen(); })
      .catch(function () { /* Standardwerte reichen */ });
  }
  async function pushAn() {
    if (!pushKann()) { toast('Dieser Browser kann keine Mitteilungen'); return; }
    try {
      const erlaubnis = await Notification.requestPermission();
      if (erlaubnis !== 'granted') { toast('Mitteilungen wurden nicht erlaubt'); return; }
      const reg = swReg || await navigator.serviceWorker.ready;
      const k = await api('push/schluessel');
      const abo = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ZuBytes(k.schluessel)
      });
      await api('push/anmelden', { method: 'POST', body: { abo: abo.toJSON(), geraet: geraetName() } });
      pushAbo = abo;
      pushFehler = null;
      toast('Mitteilungen sind aktiv');
      pushModalLaden();
    } catch (e) { pushFehler = e.message; }
    render();
  }
  async function pushAus() {
    try {
      if (pushAbo) {
        await api('push/abmelden', { method: 'POST', body: { endpoint: pushAbo.endpoint } });
        await pushAbo.unsubscribe();
      }
      pushAbo = null;
      toast('Auf diesem Gerät ausgeschaltet');
      pushModalLaden();
    } catch (e) { toast(e.message); }
    render();
  }

  // ---------------------------------------------------------------
  //  Mietkonto
  // ---------------------------------------------------------------
  function letzteMonate(anzahl) {
    const liste = [];
    const d = new Date();
    for (let i = anzahl - 1; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      liste.push({
        schluessel: m.getFullYear() + '-' + String(m.getMonth() + 1).padStart(2, '0'),
        kurz: m.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
      });
    }
    return liste;
  }

  function soll(x) { return netto(x) + n(x.nk); }

  function kontoSaldo(x, monate) {
    let offen = 0;
    monate.forEach(function (m) {
      const gezahlt = (x.zahlungen && x.zahlungen[m.schluessel] != null)
        ? n(x.zahlungen[m.schluessel]) : null;
      if (gezahlt === null) return;          // noch nicht erfasst
      offen += soll(x) - gezahlt;
    });
    return offen;
  }

  const kaution = function (x) { return x.deposit != null ? n(x.deposit) : n(x.rent) * 2; };
  const parkTypes = ['Stellplatz', 'Garage'];

  // Wann darf die Miete das naechste Mal steigen?
  // Basis: letzte Erhoehung, sonst Einzug. Wirksam fruehestens 15 Monate spaeter,
  // ankuendigen 3 Monate davor. Kappungsgrenze: hoechstens 20 % in drei Jahren.
  function erhoehung(x, benchmark) {
    const r = { moeglich: false, ziel: 0, potenzial: 0, ab: null, istQm: 0, grund: '' };
    if (parkTypes.indexOf(x.type) !== -1 || x.status !== 'vermietet') return r;
    if (!n(x.rent) || !n(x.area) || !benchmark) { r.grund = 'Fläche oder Miete fehlt'; return r; }
    r.istQm = n(x.rent) / n(x.area);
    const soll = n(x.area) * benchmark;
    const kappung = n(x.rent) * 1.2;
    r.ziel = Math.min(soll, kappung);
    r.potenzial = Math.max(0, r.ziel - n(x.rent));
    const basis = x.lastIncrease || x.movein;
    if (basis) {
      const d = new Date(basis);
      if (!isNaN(d)) { d.setMonth(d.getMonth() + 15); r.ab = d; }
    }
    r.moeglich = r.potenzial >= 1 && (!r.ab || r.ab <= new Date());
    if (r.potenzial < 1) r.grund = 'Miete liegt auf Vergleichsniveau';
    else if (soll > kappung) r.grund = 'durch Kappungsgrenze begrenzt';
    return r;
  }
  const money = function (v) {
    if (v === null || v === undefined || v === '' || v === 0) return '—';
    return Number(v).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €';
  };
  const dateDE = function (s) { if (!s) return '—'; const p = s.split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : s; };
  const esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  const allUnits = function () {
    return data.objects.reduce(function (a, o) { return a.concat(o.units.map(function (x) { return { o: o, u: x }; })); }, []);
  };
  const matches = function (o, x) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (o.name + ' ' + x.name + ' ' + x.tenant + ' ' + x.type + ' ' + (x.note || '') + ' ' + (x.contact || ''))
      .toLowerCase().indexOf(q) !== -1;
  };
  const findObj = function (id) { return data.objects.find(function (o) { return o.id === id; }); };
  const label = function (s) {
    return s === 'vermietet' ? 'Vermietet' : s === 'frei' ? 'Frei'
      : s === 'gesperrt' ? 'Nicht vermietbar' : 'Offen';
  };

  function render() {
    if (phase === 'einrichten') { renderEinrichten(); return; }
    if (phase === 'anmelden') { renderAnmelden(); return; }
    tdEditorMerken();
    modalEntwurfMerken();
    const units = allUnits();
    const rented = units.filter(function (x) { return x.u.status === 'vermietet'; });
    const free = units.filter(function (x) { return x.u.status === 'frei'; });
    const nettoSum = rented.reduce(function (s, x) { return s + netto(x.u); }, 0);
    const nkSum = rented.reduce(function (s, x) { return s + n(x.u.nk); }, 0);
    const lost = free.reduce(function (s, x) { return s + netto(x.u); }, 0);
    const missing = rented.filter(function (x) { return !netto(x.u); }).length;

    let html = '';
    html += '<div class="top"><div class="marke">'
      + '<button class="burger" data-act="seite" title="Menü"><span></span><span></span><span></span></button>'
      + '<div class="siegel">Z</div>'
      + '<div><h1>Ziegler</h1></div></div>'
      + '<div class="top-actions">'
      + '<button class="theme lupe" data-act="suche" title="Suchen (Strg+K)" aria-label="Suchen">'
      + '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg></button>'
      + '</div></div>';

    html += '<div class="seitennav">'
      + [['heute', 'Heute'], ['aufgaben', 'Aufgaben'], ['objekte', 'Objekte'], ['mieten', 'Mieten'],
         ['interessenten', 'Interessenten'], ['post', 'Post'], ['rechnungen', 'Abrechnungen']].map(function (t) {
          return '<button class="' + (ansicht === t[0] ? 'aktiv' : '') + '" data-act="zu-' + t[0] + '">' + t[1] + '</button>';
        }).join('')
      + '</div>';

    // ---- Seitenleiste ----
    if (seiteOffen) {
      const eintrag = function (act, name, zusatz) {
        return '<button data-act="' + act + '"><span>' + name + '</span>'
          + (zusatz ? '<span class="sl-zusatz">' + zusatz + '</span>' : '') + '</button>';
      };
      html += '<div class="sl-schatten" data-act="seite-zu"></div>'
        + '<div class="seitenleiste">'
        + '<div class="sl-kopf"><div class="siegel">Z</div><div>'
        + '<div class="sl-name">Ziegler</div>'
        + '<div class="sl-nutzer">' + esc(nutzerName) + '</div></div>'
        + '<button class="sl-zu" data-act="seite-zu">✕</button></div>'

        // Am PC stehen alle Bereiche als Reiter oben, am Handy fünf unten in der Leiste
        + (mobil
            ? '<div class="sl-gruppe"><span>Weitere Bereiche</span>'
              + eintrag('zu-interessenten', 'Interessenten')
              + eintrag('zu-rechnungen', 'Abrechnungen')
              + '</div>'
            : '')

        + '<div class="sl-gruppe"><span>Verwaltung</span>'
        + eintrag('add-object', 'Objekt anlegen')
        + eintrag('interessent-neu', 'Interessent vormerken')
        + eintrag('auszug', 'Kontoauszug einlesen')
        + eintrag('staende', 'Verlauf', zuletztGeaendert
            ? new Date(zuletztGeaendert.wann).toLocaleString('de-DE', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
              + ' · ' + esc(zuletztGeaendert.wer)
            : '')
        + '</div>'

        + '<div class="sl-gruppe"><span>Verbindungen</span>'
        + eintrag('todoist', 'Todoist', todoist.verbunden ? 'verbunden' : 'offen')
        + eintrag('google', 'Postfach', google.verbunden ? 'verbunden' : 'offen')
        + eintrag('gkal', 'Kalender', gkal.eingerichtet ? 'verbunden' : 'offen')
        + eintrag('push', 'Mitteilungen', pushAbo ? 'aktiv' : 'aus')
        + eintrag('stimme', 'Vorlesestimme', stimme.verbunden ? 'verbunden' : 'Gerät')
        + eintrag('assistent', 'Assistent', assistent.verbunden ? 'verbunden' : 'aus')
        + '</div>'

        + '<div class="sl-gruppe"><span>Daten</span>'
        + (function () {
            let her = null;
            try { her = window.localStorage.getItem(SICHERUNG_ZEIT); } catch (e) { /* egal */ }
            const tage = her ? Math.floor((Date.now() - Number(her)) / 86400000) : null;
            return eintrag('datei-sichern', 'Auf dieses Gerät sichern',
              tage === null ? 'noch nie' : (tage === 0 ? 'heute' : 'vor ' + tage + ' T.'));
          })()
        + (nutzerRolle === 'verwalter'
            ? eintrag('server-sicherung', 'Server-Sicherung',
                sicherungInfo ? (sicherungInfo.driveFehler || sicherungInfo.lokalFehler ? 'prüfen' : 'täglich') : '')
            : '')
        + eintrag('datei-laden', 'Aus Datei laden')
        + eintrag('export', 'Als Tabelle kopieren')
        + '</div>'

        // Zugänge für alle: dort ändert jeder sein eigenes Passwort, Verwaltung sieht nur der Verwalter
        + '<div class="sl-gruppe"><span>Einstellungen</span>'
        + eintrag('theme', 'Darstellung', { auto: 'wie das Gerät', light: 'hell', dark: 'dunkel' }[themeWahl])
        + eintrag('absender-rg', 'Rechnungsabsender')
        + eintrag('absender-nk', 'Vermieter für Nebenkosten')
        + '</div>'

        + '<div class="sl-gruppe"><span>Konto</span>'
        + eintrag('zugaenge', nutzerRolle === 'verwalter' ? 'Zugänge' : 'Passwort ändern') + '</div>'

        + '<div class="sl-fuss">' + eintrag('abmelden', 'Abmelden') + '</div>'
        + '</div>';
    }

    // ---- Eigene Seite: Aufgaben ----
    if (ansicht === 'aufgaben') {
      html += aufgabenAbschnitt();
    }

    // ---- Eigene Seite: Mieten ----
    if (ansicht === 'mieten') {
      html += mietenAbschnitt();
      html += rueckstaendeAbschnitt();
    }

    // ---- Eigene Seite: Interessenten ----
    if (ansicht === 'interessenten') {
      html += interessentenAbschnitt();
      html += freieEinheitenAbschnitt();
    }

    // ---- Eigene Seite: Post ----
    if (ansicht === 'post') {
      if (google.verbunden) {
        html += postAbschnitt();
      } else {
        html += '<div class="tafel"><h3>Post</h3>'
          + '<div class="unit-type">Das Postfach ist noch nicht verbunden — danach liegen hier alle zugeordneten Mails.</div>'
          + '<div class="modal-actions" style="justify-content:flex-start;margin-top:10px">'
          + '<button class="tiny" data-act="google">Verbinden</button></div></div>';
      }
    }

    // ---- Eigene Seite: Rechnungen ----
    if (ansicht === 'rechnungen') {
      html += '<div class="rg-tabs">'
        + '<button data-act="rg-tab" data-tab="as" class="' + (rgTab === 'as' ? 'aktiv' : '') + '">Allgemeinstrom</button>'
        + '<button data-act="rg-tab" data-tab="pv" class="' + (rgTab === 'pv' ? 'aktiv' : '') + '">Solarstrom</button>'
        + '<button data-act="rg-tab" data-tab="nk" class="' + (rgTab === 'nk' ? 'aktiv' : '') + '">Nebenkosten</button>'
        + '</div>';
      html += rgTab === 'nk' ? nebenkostenAbschnitt() : rechnungenAbschnitt();
    }

    if (ansicht === 'objekte') {

    // ---- Kennzahlen ----
    const istPark = function (x) { return parkTypes.indexOf(x.type) !== -1; };
    const wohnAll = units.filter(function (x) { return !istPark(x.u); });
    const parkAll = units.filter(function (x) { return istPark(x.u); });
    const wohnV = wohnAll.filter(function (x) { return x.u.status === 'vermietet'; });
    const parkV = parkAll.filter(function (x) { return x.u.status === 'vermietet'; });
    const wohnFrei = wohnAll.filter(function (x) { return x.u.status === 'frei'; }).length;
    const parkFrei = parkAll.filter(function (x) { return x.u.status === 'frei'; }).length;
    const wohnNetto = wohnV.reduce(function (a, x) { return a + netto(x.u); }, 0);
    const parkNetto = parkV.reduce(function (a, x) { return a + netto(x.u); }, 0);

    const monate6 = letzteMonate(6);
    const rueckstand = data.objects.reduce(function (a, o) {
      return a + o.units.reduce(function (b, x) {
        return b + (x.status === 'vermietet' ? Math.max(0, kontoSaldo(x, monate6)) : 0);
      }, 0);
    }, 0);
    const quote = units.length ? Math.round(rented.length / units.length * 100) : 0;

    html += '<div class="kpis">'
      + '<div class="kpi hero">'
      + '<div class="label">Nettomiete monatlich</div>'
      + '<div class="value num">' + money(nettoSum) + '</div>'
      + '<div class="herozeile">'
      + '<span>' + money(nettoSum * 12) + ' im Jahr</span>'
      + '<span>' + money(nkSum) + ' NK</span>'
      + (missing ? '<span class="warnung">' + missing + ' ohne Betrag</span>' : '')
      + '</div></div>'

      + '<div class="kpi">'
      + '<div class="label">Jahresmiete netto</div>'
      + '<div class="value num">' + money(nettoSum * 12) + '</div>'
      + '<div class="aufteilung">'
      + '<div class="teil"><span>Wohnen und Gewerbe</span><span class="num">' + money(wohnNetto * 12) + '</span></div>'
      + '<div class="teil"><span>Garagen und Stellplätze</span><span class="num">' + money(parkNetto * 12) + '</span></div>'
      + '</div></div>'

      + '<div class="kpi">'
      + '<div class="label">Vermietung</div>'
      + '<div class="value num">' + quote + ' <small>%</small></div>'
      + '<div class="balken"><span style="width:' + quote + '%"></span></div>'
      + '<div class="kpizeile">' + rented.length + ' von ' + units.length + ' Einheiten'
      + (free.length ? ' · ' + free.length + ' frei' : '') + '</div></div>'

      + kpi('Entgangen durch Leerstand', money(lost), false,
          free.length ? free.length + ' Einheiten frei' : 'kein Leerstand')
      + kpi('Rückstände', rueckstand > 0.5 ? '<span class="rot">' + money(rueckstand) + '</span>' : '—',
          false, 'letzte 6 Monate')
      + '</div>';

    html += '<div class="kpis split">'
      + kpi('Wohnungen und Gewerbe', wohnAll.length
          + '<small> · ' + wohnV.length + ' vermietet'
          + (wohnFrei ? ' · ' + wohnFrei + ' frei' : '') + '</small>',
          false, money(wohnNetto) + ' netto im Monat')
      + kpi('Garagen und Stellplätze', parkAll.length
          + '<small> · ' + parkV.length + ' vermietet'
          + (parkFrei ? ' · ' + parkFrei + ' frei' : '') + '</small>',
          false, money(parkNetto) + ' netto im Monat')
      + '</div>';

    } // Kennzahlen (Objekte)

    if (ansicht === 'heute') {
    // ---- Mein Tag: Reihenfolge, Woche und Zeitplan in einer Karte ----
    (function () {
      const heuteIso = heuteISO();
      if (!kalTag) kalTag = heuteIso;
      const istHeute = kalTag === heuteIso;
      const belegung = kalBelegung();
      const gewaehlt = new Date(Number(kalTag.slice(0, 4)), Number(kalTag.slice(5, 7)) - 1, Number(kalTag.slice(8, 10)));
      const tages = kalTagListe(kalTag, belegung);
      const zeitplan = kalZeitplan(kalTag, belegung);
      const punkte = memoPunkte();
      const kannSprechen = stimme.verbunden || ('speechSynthesis' in window);
      const naechsteFrist = faelligkeiten().filter(function (f) { return f.art === 'bald'; })[0];

      // Google-Termine rund um den gewählten Tag holen (läuft im Hintergrund)
      (function () {
        const von = new Date(gewaehlt); von.setDate(von.getDate() - 10);
        const bis = new Date(gewaehlt); bis.setDate(bis.getDate() + 21);
        gkalNachladen(kalIso(von), kalIso(bis));
      })();

      // Vorlesen liest heute die Reihenfolge, an anderen Tagen den gewählten Tag
      const quelle = istHeute ? 'memo' : 'kal';
      const laeuft = (istHeute ? sprichQuelle !== 'kal' : sprichQuelle === 'kal');

      html += '<div class="tafel heute memo tagkarte' + (memoWunsch ? ' wunsch' : '') + '">'
        + '<div class="memokopf"><h3>' + (istHeute ? 'Heute · ' : '')
        + esc(gewaehlt.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })) + '</h3>'
        + '<div class="memoknoepfe">'
        + (assistent.verbunden && istHeute
            ? '<button type="button" class="mikro' + (hoert ? ' hoert' : '') + '" data-act="memo-hoeren">'
              + '<span class="punkt"></span>'
              + (hoert ? 'Fertig' : (denkt ? 'Moment …' : 'Sagen')) + '</button>'
            : '')
        + (kannSprechen
            ? '<button type="button" class="vorlesen' + (laeuft && (memoLaeuft || memoLaedt) ? ' laeuft' : '') + '" data-act="' + quelle + '-sprechen">'
              + '<span class="punkt"></span>'
              + (laeuft && memoLaedt ? 'Moment …' : (laeuft && memoLaeuft ? 'Stopp' : 'Vorlesen')) + '</button>'
            : '')
        + '<span class="tagnav">'
        + '<button type="button" data-act="kal-zurueck" title="Woche zurück">‹</button>'
        + (istHeute ? '' : '<button type="button" data-act="kal-heute">Heute</button>')
        + '<button type="button" data-act="kal-vor" title="Woche vor">›</button>'
        + '</span>'
        + '</div></div>';

      // --- Wochenstreifen ---
      const wochenstart = new Date(gewaehlt);
      wochenstart.setDate(gewaehlt.getDate() - ((gewaehlt.getDay() + 6) % 7));
      html += '<div class="kalwochenstreifen">';
      for (let i = 0; i < 7; i++) {
        const tag = new Date(wochenstart); tag.setDate(wochenstart.getDate() + i);
        const iso = kalIso(tag);
        const b = belegung[iso] || { aufgaben: [], termine: [], fristen: [], gtermine: [] };
        const punkte = [];
        if (b.aufgaben.length) punkte.push('<span class="kalpunkt' + (iso < heuteIso ? ' spaet' : '') + '"></span>');
        if (b.termine.length) punkte.push('<span class="kalpunkt termin"></span>');
        if (b.gtermine.length) punkte.push('<span class="kalpunkt gkal"></span>');
        if (b.fristen.length) punkte.push('<span class="kalpunkt spaet"></span>');
        html += '<div class="kaltag' + (iso === heuteIso ? ' heute' : '')
          + (iso === kalTag ? ' gewaehlt' : '') + (kalSchiebt ? ' ziel' : '')
          + '" data-act="kal-tag" data-datum="' + iso + '">'
          + '<span class="wtag">' + esc(tag.toLocaleDateString('de-DE', { weekday: 'short' }).slice(0, 2)) + '</span>'
          + '<span class="wzahl">' + tag.getDate() + '</span>'
          + (punkte.length ? '<div class="kalpunkte">' + punkte.slice(0, 3).join('') + '</div>' : '')
          + '</div>';
      }
      html += '</div>';


      if (istHeute) html += planLeisteHtml();

      if (stimme.verbunden) {
        html += '<div class="memostimme"><label for="memo-stimme">Stimme</label>'
          + '<select id="memo-stimme">'
          + KI_STIMMEN.map(function (v) {
              return '<option value="' + v[0] + '"' + (v[0] === stimme.stimme ? ' selected' : '') + '>'
                + esc(v[1]) + '</option>';
            }).join('')
          + '</select></div>';
      }
      const stimmen = (!stimme.verbunden && kannSprechen) ? memoStimmen() : [];
      if (stimmen.length > 1) {
        const aktuell = memoStimme();
        html += '<div class="memostimme"><label for="memo-stimme">Stimme</label>'
          + '<select id="memo-stimme">'
          + stimmen.map(function (v) {
              return '<option value="' + esc(v.name) + '"'
                + (aktuell && v.name === aktuell.name ? ' selected' : '') + '>'
                + esc(v.name.replace(/\s*\((German|Germany|Deutsch|Deutschland)[^)]*\)/i, ''))
                + (MEMO_MAENNLICH.test(v.name) ? ' — männlich' : '')
                + '</option>';
            }).join('')
          + '</select></div>';
      }


      html += '<div class="tagspalten"><div class="tagliste">';

      if (istHeute) {
        // 1 — was rechts im Zeitplan für heute steht, in der Reihenfolge des Tages
        const jetztMin = new Date().getHours() * 60 + new Date().getMinutes();
        const geplant = zeitplan.slice().sort(function (x, y) { return x.von - y.von; });
        html += '<div class="tagabschnitt"><span>Heute eingeplant</span>'
          + (geplant.length ? '<span class="anzahl">' + geplant.length + '</span>' : '') + '</div>';
        if (!geplant.length) {
          html += '<div class="memosatz">Noch nichts mit Uhrzeit — „Tag planen“ legt Aufgaben in die freie Zeit.</div>';
        } else {
          html += '<ol class="memoliste planliste">' + geplant.map(function (e) {
            const vorbei = e.von + (e.dauer || 30) <= jetztMin;
            const jetzt = !vorbei && e.von <= jetztMin;
            const ziel = e.tid ? ' data-act="td-oeffnen" data-tid="' + e.tid + '"'
              : (e.act ? ' data-act="' + e.act + '"' + (e.id ? ' data-id="' + esc(String(e.id)) + '"' : '') : '');
            // Termine aus dem Kalender und Besichtigungen hakt man hier ab (gemerkt in den Daten);
            // Aufgaben werden wie überall in Todoist erledigt
            const schluessel = e.art + ':' + (e.tid || e.id) + '@' + kalTag;
            const abgehakt = !e.tid && kalAbgehakt(schluessel);
            // Vorbei, aber nicht abgehakt: nicht verblassen lassen, sondern als offen zeigen
            const liegen = vorbei && !abgehakt;
            return '<li class="mpunkt' + (ziel ? ' klickbar' : '') + (abgehakt ? ' abgehakt' : '') + (liegen ? ' liegen' : '') + (jetzt ? ' jetzt' : '') + '"' + ziel
              + (e.tid && !mobil ? ' draggable="true" data-zieh="' + e.tid + '" title="In den Zeitplan ziehen, um die Uhrzeit zu ändern"' : '') + '>'
              + '<span class="mtext"><span class="mwas">' + esc(e.titel) + '</span>'
              + '<span class="mwarum">' + (abgehakt ? 'erledigt' : (jetzt ? 'läuft gerade' : (liegen ? '<span class="rot">noch offen</span>' : 'geplant')))
              + (e.unten ? ' · ' + esc(e.unten) : '') + '</span></span>'
              + (e.tid
                  ? '<button type="button" class="td-kreis" data-act="td-fertig" data-tid="' + e.tid + '" title="Abhaken">' + TDI.check + '</button>'
                  : '<button type="button" class="td-kreis' + (abgehakt ? ' an' : '') + '" data-act="kal-abhaken" data-k="' + esc(schluessel) + '" title="' + (abgehakt ? 'Wieder offen' : 'Abhaken') + '">' + TDI.check + '</button>')
              + '</li>';
          }).join('') + '</ol>';
        }

        // 2 — was noch nicht eingeplant ist: Überfälliges, Heutiges ohne Uhrzeit, Fristen, Geld, Anfragen
        const offen = punkte.filter(function (p) { return !p.zeit; });
        html += '<div class="tagabschnitt"><span>Noch nicht eingeplant</span>'
          + (offen.length ? '<span class="anzahl' + (offen.some(function (p) { return p.rot; }) ? ' rot' : '') + '">' + offen.length + '</span>' : '') + '</div>';
        if (!offen.length) {
          html += '<div class="memosatz">Alles hat seinen Platz.</div>';
        } else {
          html += '<div class="memosatz">Daran ist noch nichts passiert — von oben nach unten.</div>';
          const zeigen = memoAlle ? offen : offen.slice(0, 5);
          html += '<ol class="memoliste">' + zeigen.map(function (p, i) {
            const ziel = p.tid
              ? ' data-act="td-oeffnen" data-tid="' + p.tid + '"'
              : (p.act ? ' data-act="' + p.act + '"' + (p.id ? ' data-id="' + p.id + '"' : '') : '');
            return '<li class="mpunkt' + (ziel ? ' klickbar' : '') + '"' + ziel
              + (p.tid && !mobil ? ' draggable="true" data-zieh="' + p.tid + '" title="In den Zeitplan ziehen, um sie einzuplanen"' : '') + '>'
              + '<span class="mnr' + (p.rot ? ' rot' : '') + '">' + (i + 1) + '</span>'
              + '<span class="mtext">'
              + '<span class="mwas">' + esc(p.was) + '</span>'
              + '<span class="mwarum">' + (p.wo ? esc(p.wo) + ' · ' : '') + esc(p.warum) + '</span>'
              + '</span>'
              + (p.tid ? '<button type="button" class="td-kreis" data-act="td-fertig" data-tid="' + p.tid + '" title="Abhaken">' + TDI.check + '</button>' : '')
              + '</li>';
          }).join('') + '</ol>';
          if (offen.length > 5) {
            html += '<button type="button" class="memomehr" data-act="memo-alle">'
              + (memoAlle ? 'Weniger zeigen' : 'und ' + (offen.length - 5) + ' weitere zeigen') + '</button>';
          }
        }
        // Ganztägige Google-Termine stehen sonst nirgends in der Liste
        const ganzeGkal = tages.gtermine.filter(function (g) { return g.ganztags; });
        if (ganzeGkal.length) {
          html += '<div class="ganztags">' + ganzeGkal.map(function (g) {
            return '<div class="gpille gkal" data-act="gkal-info" data-id="' + esc(g.id) + '"><span>' + esc(g.titel) + '</span></div>';
          }).join('') + '</div>';
        }
      } else {
        // Ein anderer Tag: was dort ohne Uhrzeit ansteht
        const ohneZeit = tages.aufgaben.filter(function (t) { return !t.faelligZeit; });
        const liste = []
          .concat(tages.fristen.map(function (f) { return { art: 'frist', text: f.was, unten: String(f.objekt || '').split(',')[0] }; }))
          .concat(tages.gtermine.filter(function (g) { return g.ganztags; }).map(function (g) {
            return { art: 'gkal', text: g.titel, unten: 'ganztägig', ziel: 'data-act="gkal-info" data-id="' + esc(g.id) + '"' };
          }))
          .concat(ohneZeit.map(function (t) {
            return { art: kalTag < heuteIso ? 'spaet' : '', text: t.inhalt, unten: tdProjektName(t.projektId) || '', tid: t.id,
              ziel: 'data-act="td-oeffnen" data-tid="' + t.id + '"' };
          }));
        if (!liste.length) html += '<div class="memosatz">Ohne Uhrzeit steht an diesem Tag nichts an.</div>';
        else {
          html += '<div class="memosatz">' + liste.length + (liste.length === 1 ? ' Sache' : ' Sachen') + ' ohne Uhrzeit.</div>';
          html += '<ol class="memoliste ohnenr">' + liste.map(function (e) {
            return '<li class="mpunkt' + (e.ziel ? ' klickbar' : '') + ' ' + e.art + '" ' + (e.ziel || '') + '>'
              + '<span class="mtext"><span class="mwas">' + esc(e.text) + '</span>'
              + (e.unten ? '<span class="mwarum">' + esc(e.unten) + '</span>' : '') + '</span>'
              + (e.tid ? '<button type="button" class="td-kreis" data-act="td-fertig" data-tid="' + e.tid + '" title="Abhaken">' + TDI.check + '</button>' : '')
              + '</li>';
          }).join('') + '</ol>';
        }
      }
      html += '</div>';

      // Rechte Spalte (am Handy darunter): der Zeitplan mit Uhrzeiten
      html += '<div class="tagzeit"><div class="tagzeit-kopf">Zeitplan</div>';
      // Ohne einen einzigen Eintrag mit Uhrzeit reicht eine Zeile statt eines leeren Rasters.
      // Am PC bleibt das Raster auch leer stehen — man kann Aufgaben hineinziehen
      if (!zeitplan.length && mobil) {
        html += '<div class="kalleer">'
          + (istHeute ? 'Heute' : 'An diesem Tag')
          + ' keine Termine mit Uhrzeit.</div>';
      } else (function () {
        const HOEHE = KAL_HOEHE;
        const jetzt = new Date();
        const oben = function (minuten) { return minuten / 60 * HOEHE; };

        html += '<div class="zeitrahmen"><div class="zeitachse" style="height:' + (24 * HOEHE) + 'px">';
        for (let st = 0; st <= 23; st++) {
          html += '<div class="zstunde" style="top:' + oben(st * 60) + 'px"><b>'
            + String(st).padStart(2, '0') + ':00</b></div>';
        }
        html += '<div class="zspalte">'
          + zeitplan.map(function (e, nr) {
              const spaet = e.art === 'aufgabe' && istHeute && (e.von + e.dauer) < (jetzt.getHours() * 60 + jetzt.getMinutes());
              const stunde = String(Math.floor(e.von / 60)).padStart(2, '0') + ':'
                + String(e.von % 60).padStart(2, '0');
              const lage = 'left:0;width:calc(100% - 2px);';
              const hoch = Math.max(28, e.dauer / 60 * HOEHE - 3);
              return '<div class="ztermin ' + e.art + (spaet ? ' spaet' : '') + '" '
                + 'style="top:' + oben(e.von) + 'px;height:' + hoch + 'px;' + lage
                + 'z-index:' + (2 + nr) + '" '
                + 'data-echt="' + oben(e.von) + '" data-hoch="' + hoch + '" '
                + 'data-act="' + e.act + '"' + (e.tid ? ' data-tid="' + e.tid + '"' : '')
                + (e.id ? ' data-id="' + e.id + '"' : '') + ' data-ende="' + (e.von + e.dauer) + '">'
                + '<b>' + esc(e.titel) + '</b>'
                + '<i>' + stunde + (e.unten ? ' · ' + esc(e.unten) : '') + '</i>'
                + '</div>';
            }).join('')
          + '</div>';
        if (istHeute) {
          html += '<div class="zjetzt" style="top:' + oben(jetzt.getHours() * 60 + jetzt.getMinutes()) + 'px;z-index:60"></div>';
        }
        html += '</div></div>';
      })();

      html += '</div></div>';

      // --- darunter nur noch: neue Aufgabe für diesen Tag ---
      if (todoist.verbunden) {
        html += tdNeuHtml('kal:' + kalTag, { faellig: kalTag });
      } else {
        html += '<div class="unit-type" style="margin-top:10px">Todoist ist nicht verbunden — dann stehen hier deine Aufgaben.</div>'
          + '<div class="modal-actions" style="justify-content:flex-start;margin-top:10px">'
          + '<button class="tiny" data-act="todoist">Verbinden</button></div>';
      }


      if (assistent.verbunden && (gespraech.length || hoert || denkt)) {
        html += '<div class="gespraech">'
          + gespraech.slice(-4).map(function (z) {
              return '<div class="g-zeile"><b>' + (z.wer === 'ich' ? 'Du' : 'Ich') + '</b>'
                + '<span class="' + (z.wer === 'ich' ? 'g-ich' : 'g-du') + '">' + esc(z.text) + '</span></div>';
            }).join('')
          + (hoert ? '<div class="g-zeile"><b></b><span class="g-du">Ich höre zu …</span></div>' : '')
          + (denkt ? '<div class="g-zeile"><b></b><span class="g-du">Einen Moment …</span></div>' : '')
          + '</div>';
      }
      if (assistent.verbunden) {
        html += '<div class="g-feld">'
          + '<input type="text" id="a-text" placeholder="oder tippen: „Kaminkehrer anrufen, Bertha, morgen“">'
          + '<button type="button" class="tiny" data-act="assistent-senden">Senden</button></div>';
      }

      if (naechsteFrist) {
        html += '<div class="memofrist">Nächste Frist: ' + esc(naechsteFrist.was) + ' · '
          + esc(String(naechsteFrist.objekt || '').split(',')[0]) + ' · '
          + esc(naechsteFrist.wann.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }))
          + '</div>';
      }

      html += '</div>';
    })();
    } // Heute-Seite

    if (ansicht === 'objekte') {

    // ---- Fällig und offen aus der Verwaltung ----
    const faellig = faelligkeiten();
    if (faellig.length) {
      const zeige = faellig.slice(0, 6);
      html += '<div class="tafel"><h3>Fällig und offen</h3>'
        + zeige.map(function (f) {
            return '<div class="faellig ' + f.art + '">'
              + '<div class="fpunkt"></div>'
              + '<div class="fgrow"><div class="fwas">' + esc(f.was) + '</div>'
              + '<div class="fobj">' + esc(f.objekt) + '</div></div>'
              + '<div class="fwann num">' + (f.art === 'chance' ? 'jetzt' : f.wann.toLocaleDateString('de-DE')) + '</div>'
              + '</div>';
          }).join('')
        + (faellig.length > 6 ? '<div class="unit-type" style="margin-top:8px">und '
            + (faellig.length - 6) + ' weitere</div>' : '')
        + '<div class="modal-actions" style="justify-content:flex-start;margin-top:12px">'
        + '<button class="tiny" data-act="todoist">'
        + (todoist.verbunden ? 'Nach Todoist übertragen' : 'Mit Todoist verbinden') + '</button></div>'
        + '</div>';
    }

    } // Fällig (Objekte)


    if (ansicht === 'objekte') {

    html += '<div class="searchrow">'
      + '<input type="text" id="q" placeholder="Mieter, Einheit oder Objekt suchen" value="' + esc(query) + '">'
      + (query ? '<button data-act="clear-q" class="ghost">Suche zurücksetzen</button>' : '') + '</div>';

    data.objects.forEach(function (o) {
      const shown = o.units.filter(function (x) { return matches(o, x); });
      if (query && shown.length === 0) return;
      const r = o.units.filter(function (x) { return x.status === 'vermietet'; });
      const f = o.units.filter(function (x) { return x.status === 'frei'; }).length;
      const oNetto = r.reduce(function (s, x) { return s + netto(x); }, 0);
      const isOpen = query ? true : !!open[o.id];

      const oRueck = o.units.reduce(function (a, x) {
        return a + (x.status === 'vermietet' ? Math.max(0, kontoSaldo(x, letzteMonate(6))) : 0);
      }, 0);
      const oAufgaben = (aufgaben[o.id] || []).length;
      const oQuote = o.units.length ? Math.round(r.length / o.units.length * 100) : 0;

      html += '<div class="obj' + (isOpen ? ' offen' : '') + '">'
        + '<div class="obj-head" data-act="toggle" data-id="' + o.id + '">'
        + '<span class="caret">' + (isOpen ? '▾' : '▸') + '</span><div class="obj-grow">'
        + '<div class="obj-title">' + esc(o.name) + '</div>'
        + '<div class="obj-meta">'
        + '<span class="mtag">' + o.units.length + ' Einheiten</span>'
        + (oNetto ? '<span class="mtag stark num">' + money(oNetto) + '</span>' : '')
        + (f ? '<span class="mtag frei">' + f + ' frei</span>' : '')
        + (oRueck > 0.5 ? '<span class="mtag rot num">' + money(oRueck) + ' offen</span>' : '')
        + (oAufgaben ? '<span class="mtag">' + oAufgaben + ' Aufgaben</span>' : '')
        + '</div>'
        + '<div class="objbalken"><span style="width:' + oQuote + '%"></span></div>'
        + '</div><div class="strip">'
        + o.units.map(function (x) { return '<div class="tick ' + x.status + '" title="' + esc(x.name) + '"></div>'; }).join('')
        + '</div></div>';

      if (isOpen) {
        const tab = reiter[o.id] || 'einheiten';
        const offeneAufgaben = (aufgaben[o.id] || []).length;
        const ueberfaellig = (aufgaben[o.id] || []).some(function (t) {
          return t.faellig && new Date(t.faellig) < new Date();
        });

        html += '<div class="obj-body">';

        // Reiterleiste plus Werkzeuge
        html += '<div class="reiterzeile">'
          + '<div class="reiter">'
          + ['einheiten', 'zahlen', 'aufgaben'].map(function (r) {
              const namen = { einheiten: 'Einheiten', zahlen: 'Zahlen', aufgaben: 'Aufgaben' };
              return '<button class="rtab' + (tab === r ? ' aktiv' : '') + '" data-act="reiter" '
                + 'data-id="' + o.id + '" data-r="' + r + '">' + namen[r]
                + (r === 'einheiten' ? ' <span class="zahl">' + o.units.length + '</span>' : '')
                + (r === 'aufgaben' && offeneAufgaben ? ' <span class="zahl' + (ueberfaellig ? ' rot' : '') + '">'
                    + offeneAufgaben + '</span>' : '')
                + '</button>';
            }).join('')
          + '</div>'
          + '<div class="werkzeuge">'
          + '<button class="tiny ghost" data-act="konto" data-id="' + o.id + '">Mietkonto</button>'
          + '<button class="tiny ghost" data-act="nk" data-id="' + o.id + '">Nebenkosten</button>'
          + '<button class="tiny ghost" data-act="strom" data-id="' + o.id + '">Strom</button>'
          + '<button class="tiny ghost" data-act="wartung" data-id="' + o.id + '">Prüfungen</button>'
          + '<button class="tiny ghost" data-act="edit-object" data-id="' + o.id + '">Objekt</button>'
          + '</div></div>';

        // ---- Reiter: Einheiten ----
        if (tab === 'einheiten') {
          if (shown.length === 0) {
            html += '<div class="empty-note">Noch keine Einheiten. Lege die erste an, dann siehst du hier Mieter und Mieten.</div>';
          } else if (mobil) {
            // Handy: eine Karte je Einheit statt einer breiten Tabelle
            html += shown.map(function (x) {
              return '<div class="ekarte" data-act="edit-unit" data-oid="' + o.id + '" data-uid="' + x.id + '">'
                + '<div class="ekopf"><div class="ename">' + esc(x.name) + '</div>'
                + '<button class="pill klick ' + x.status + '" data-act="status" data-oid="' + o.id
                + '" data-uid="' + x.id + '">' + label(x.status) + '</button></div>'
                + '<div class="emieter">' + (x.tenant ? esc(x.tenant) : '<span class="unit-type">kein Mieter</span>')
                + (!x.tenant && x.hint ? '<div class="hintline">' + esc(x.hint) + '</div>' : '')
                + '</div>'
                + '<div class="ezahlen">'
                + '<div><span class="elabel">Netto</span><span class="num strong">' + money(netto(x)) + '</span></div>'
                + '<div><span class="elabel">NK</span><span class="num">' + money(x.nk) + '</span></div>'
                + '<div><span class="elabel">Gesamt</span><span class="num">' + money(brutto(x)) + '</span></div>'
                + (x.area ? '<div><span class="elabel">Fläche</span><span class="num">' + String(x.area).replace('.', ',') + ' m²</span></div>' : '')
                + (x.movein ? '<div><span class="elabel">Einzug</span><span class="num">' + dateDE(x.movein) + '</span></div>' : '')
                + (x.docs && x.docs.length ? '<div><span class="elabel">Dokumente</span><span class="num">' + x.docs.length + '</span></div>' : '')
                + '</div></div>';
            }).join('');
            const rented = shown.filter(function (x) { return x.status === 'vermietet'; });
            html += '<div class="ekarte summe"><div class="ekopf"><div class="ename">Summe vermietet</div>'
              + '<span class="unit-type">' + rented.length + ' Einheiten</span></div>'
              + '<div class="ezahlen">'
              + '<div><span class="elabel">Netto</span><span class="num strong">'
              + money(rented.reduce(function (a, x) { return a + netto(x); }, 0)) + '</span></div>'
              + '<div><span class="elabel">NK</span><span class="num">'
              + money(rented.reduce(function (a, x) { return a + n(x.nk); }, 0)) + '</span></div>'
              + '</div></div>';
          } else {
            html += '<div class="tabellenrahmen">';
          const wohn = shown.filter(function (x) { return parkTypes.indexOf(x.type) === -1; });
          const park = shown.filter(function (x) { return parkTypes.indexOf(x.type) !== -1; });

          // Spalten, die bei keiner Einheit etwas enthalten, fallen weg — die Tabelle bleibt übersichtlich
          const leerStrich = '<span class="unit-type">—</span>';
          const irgendwo = function (fn) { return shown.some(function (x) { return !!fn(x); }); };
          const qm = function (x) { return x.area ? String(x.area).replace('.', ',') + ' m²' : leerStrich; };
          const rentedShown = shown.filter(function (x) { return x.status === 'vermietet'; });
          const t = function (fn) { return rentedShown.reduce(function (a, x) { return a + fn(x); }, 0); };
          const flaeche = t(function (x) { return n(x.area); });
          const spalten = [
            { kopf: 'Einheit', zeige: true,
              zelle: function (x) { return '<td><div class="unit-name">' + esc(x.name) + '</div><div class="unit-type">' + esc(x.type) + '</div></td>'; } },
            { kopf: 'Mieter', cls: 'sep-l', zeige: true,
              zelle: function (x) {
                return '<td class="sep-l">' + (x.tenant ? esc(x.tenant) : leerStrich)
                  + (!x.tenant && x.hint ? '<div class="hintline">' + esc(x.hint) + '</div>' : '')
                  + (x.docs && x.docs.length ? '<div><span class="docbadge">' + x.docs.length + ' Dokument' + (x.docs.length > 1 ? 'e' : '') + '</span></div>' : '')
                  + '</td>';
              } },
            { kopf: 'Einzug', cls: 'hide-s', zeige: irgendwo(function (x) { return x.movein; }),
              zelle: function (x) { return '<td class="num hide-s">' + dateDE(x.movein) + '</td>'; } },
            { kopf: 'Status', zeige: true,
              zelle: function (x) {
                return '<td><button class="pill klick ' + x.status + '" data-act="status" data-oid="' + o.id
                  + '" data-uid="' + x.id + '" title="Status wechseln">' + label(x.status) + '</button></td>';
              } },
            { kopf: 'Fläche', cls: 'right hide-s sep-l', zeige: irgendwo(function (x) { return x.area; }),
              zelle: function (x) { return '<td class="right num hide-s sep-l">' + qm(x) + '</td>'; },
              fuss: flaeche ? flaeche.toFixed(1).replace('.', ',') + ' m²' : '' },
            { kopf: '€/m²', cls: 'right hide-s', zeige: irgendwo(function (x) { return x.area && n(x.rent); }),
              zelle: function (x) {
                return '<td class="right num hide-s">' + (x.area && n(x.rent)
                  ? (n(x.rent) / n(x.area)).toFixed(2).replace('.', ',') : leerStrich) + '</td>';
              },
              fuss: flaeche ? (t(function (x) { return n(x.rent); }) / flaeche).toFixed(2).replace('.', ',') : '' },
            { kopf: 'Kalt', cls: 'right hide-s', zeige: irgendwo(function (x) { return n(x.rent); }),
              zelle: function (x) { return '<td class="right num hide-s">' + money(x.rent) + '</td>'; },
              fuss: money(t(function (x) { return n(x.rent); })) },
            { kopf: 'Küche', cls: 'right hide-s', zeige: irgendwo(function (x) { return n(x.kitchen); }),
              zelle: function (x) { return '<td class="right num hide-s">' + money(x.kitchen) + '</td>'; },
              fuss: money(t(function (x) { return n(x.kitchen); })) },
            { kopf: 'Stellplatz', cls: 'right hide-s', zeige: irgendwo(function (x) { return n(x.parking); }),
              zelle: function (x) { return '<td class="right num hide-s">' + money(x.parking) + '</td>'; },
              fuss: money(t(function (x) { return n(x.parking); })) },
            { kopf: 'Netto', cls: 'right', zeige: true,
              zelle: function (x) { return '<td class="right num strong">' + money(netto(x)) + '</td>'; },
              fuss: money(t(netto)) },
            { kopf: 'NK', cls: 'right hide-s', zeige: irgendwo(function (x) { return n(x.nk); }),
              zelle: function (x) { return '<td class="right num hide-s">' + money(x.nk) + '</td>'; },
              fuss: money(t(function (x) { return n(x.nk); })) },
            { kopf: 'Gesamt', cls: 'right hide-s', zeige: irgendwo(function (x) { return n(x.nk); }),
              zelle: function (x) { return '<td class="right num hide-s">' + money(brutto(x)) + '</td>'; },
              fuss: money(t(brutto)) },
            { kopf: 'Kaution', cls: 'right hide-s', zeige: irgendwo(function (x) { return n(kaution(x)); }),
              zelle: function (x) { return '<td class="right num hide-s">' + money(kaution(x)) + '</td>'; },
              fuss: money(t(kaution)) },
            { kopf: 'Notiz', cls: 'hide-s sep-l', zeige: irgendwo(function (x) { return x.note; }),
              zelle: function (x) { return '<td class="hide-s sep-l notecell">' + (x.note ? esc(x.note) : leerStrich) + '</td>'; } }
          ].filter(function (sp) { return sp.zeige; });

          html += '<table class="einheiten"><thead><tr>'
            + spalten.map(function (sp) { return '<th' + (sp.cls ? ' class="' + sp.cls + '"' : '') + '>' + sp.kopf + '</th>'; }).join('')
            + '<th></th></tr></thead><tbody>';

          const rowHtml = function (x) {
            return '<tr class="unitrow" data-act="edit-unit" data-oid="' + o.id + '" data-uid="' + x.id + '" title="Bearbeiten">'
              + spalten.map(function (sp) { return sp.zelle(x); }).join('')
              + '<td class="rowpfeil" aria-hidden="true">›</td></tr>';
          };

          const groupRow = function (title, list) {
            const rented = list.filter(function (x) { return x.status === 'vermietet'; });
            const sum = rented.reduce(function (a, x) { return a + netto(x); }, 0);
            return '<tr class="grouprow"><td colspan="' + (spalten.length + 1) + '">' + title + ' · ' + list.length
              + (sum ? ' · <span class="num">' + money(sum) + ' netto</span>' : '') + '</td></tr>';
          };

          if (park.length && wohn.length) html += groupRow('Wohnungen und Gewerbe', wohn);
          wohn.forEach(function (x) { html += rowHtml(x); });
          if (park.length && wohn.length) html += groupRow('Stellplätze und Garagen', park);
          park.forEach(function (x) { html += rowHtml(x); });

          html += '</tbody><tfoot><tr>'
            + spalten.map(function (sp, i) {
                if (i === 0) return '<td>Summe vermietet · ' + rentedShown.length + ' Einheiten</td>';
                const cls = (sp.cls || '').replace('right', 'right num');
                return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + (sp.fuss || '') + '</td>';
              }).join('')
            + '<td></td></tr></tfoot></table>';
            html += '</div>';
          }
          html += '<div class="modal-actions" style="justify-content:flex-start;margin-top:12px">'
            + '<button class="tiny" data-act="add-unit" data-id="' + o.id + '">Einheit hinzufügen</button></div>';
        }

        // ---- Reiter: Zahlen ----
        if (tab === 'zahlen') {
          html += breakdown(o);
        }

        // ---- Reiter: Aufgaben ----
        if (tab === 'aufgaben') {
          if (!todoist.verbunden) {
            html += '<div class="empty-note">Todoist ist nicht verbunden. '
              + 'Oben in der Tafel „Fällig und offen" kannst du die Verbindung herstellen.</div>';
          } else if (!todoist.zuordnung || !todoist.zuordnung[o.id]) {
            html += '<div class="empty-note">Diesem Objekt ist noch kein Todoist-Projekt zugeordnet.</div>'
              + '<div class="modal-actions" style="justify-content:flex-start">'
              + '<button class="tiny" data-act="todoist">Zuordnen</button></div>';
          } else {
            const liste = aufgaben[o.id];
            if (!liste) {
              html += '<div class="empty-note">wird geladen …</div>';
            } else {
              html += tdProjektInhalt(todoist.zuordnung[o.id], 'objekt:' + o.id);
            }
          }
        }

        if (o.note) html += '<div class="unit-type" style="margin-top:10px">' + esc(o.note) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    });

    } // Objektliste

    if (mobil) {
      html += '<div class="fabwrap">'
        + (fabOffen
            ? '<div class="fabmenu">'
              + '<button data-act="fab-aufgabe">Aufgabe anlegen</button>'
              + '<button data-act="interessent-neu">Interessent vormerken</button>'
              + '<button data-act="add-object">Objekt anlegen</button>'
              + '<button data-act="auszug">Kontoauszug</button>'
              + '<button data-act="datei-sichern">Daten sichern</button>'
              + '</div>'
            : '')
        + '<button class="fab" data-act="fab">' + (fabOffen ? '✕' : '+') + '</button>'
        + '</div>'

        + '<div class="untenleiste">'
        + '<button data-act="zu-heute" class="' + (ansicht === 'heute' ? 'aktiv' : '') + '"><span>◵</span>Heute</button>'
        + '<button data-act="zu-aufgaben" class="' + (ansicht === 'aufgaben' ? 'aktiv' : '') + '"><span>✓</span>Aufgaben</button>'
        + '<button data-act="zu-objekte" class="' + (ansicht === 'objekte' ? 'aktiv' : '') + '"><span>▤</span>Objekte</button>'
        + '<button data-act="zu-mieten" class="' + (ansicht === 'mieten' ? 'aktiv' : '') + '"><span>€</span>Mieten</button>'
        + '<button data-act="zu-post" class="' + (ansicht === 'post' ? 'aktiv' : '') + '"><span>✉</span>Post</button>'
        + '<button data-act="seite"><span>≡</span>Menü</button>'
        + '</div>';
    }

    html += '<div class="foot">' + fussInhalt() + '</div>';

    if (modal) html += renderModal();
    const alterToast = root.querySelector('.toast');   // Hinweis unten überlebt den Neuaufbau
    root.innerHTML = html;
    if (alterToast) root.appendChild(alterToast);
    fussVerblassen();
    scrollSperre(!!modal);

    const bd = root.querySelector('.backdrop');
    if (bd && mobil) wischen(bd);
    else if (bd) fensterRahmen(bd);
    if (!mobil && phase === 'app') tafelnRahmen();
    wire();
    tdFokus();
  }

  function objektVonProjekt(projektId) {
    if (!todoist.zuordnung) return null;
    return data.objects.find(function (o) { return todoist.zuordnung[o.id] === projektId; }) || null;
  }

  function rueckstaendeAbschnitt() {
    const monate6 = letzteMonate(6);
    const schuldner = [];
    data.objects.forEach(function (o) {
      o.units.forEach(function (x) {
        if (x.status !== 'vermietet') return;
        const offen = kontoSaldo(x, monate6);
        if (offen > 0.5) schuldner.push({ o: o, x: x, offen: offen });
      });
    });
    if (!schuldner.length) return '';
    schuldner.sort(function (a, c) { return c.offen - a.offen; });
    const summe = schuldner.reduce(function (a, r) { return a + r.offen; }, 0);
    return '<div class="tafel"><h3>Rückstände <span class="anzahl rot">' + money(summe) + '</span>'
      + '<span class="zeitraum"><span class="mmonat">letzte 6 Monate</span></span></h3>'
      + schuldner.map(function (r) {
          return '<div class="faellig klickbar" data-act="konto" data-id="' + r.o.id + '">'
            + '<div class="fpunkt" style="background:var(--sperr)"></div>'
            + '<div class="fgrow"><div class="fwas">' + esc(r.x.tenant || r.x.name) + '</div>'
            + '<div class="fobj">' + esc(r.o.name.split(',')[0]) + ' · ' + esc(r.x.name) + '</div></div>'
            + '<div class="fwann num rueckstand">' + money(r.offen) + '</div></div>';
        }).join('')
      + '<div class="unit-type" style="margin-top:8px">Nur erfasste Monate zählen — ein Tipp auf die Zeile öffnet das Mietkonto.</div>'
      + '</div>';
  }

  function freieEinheitenAbschnitt() {
    const freie = [];
    data.objects.forEach(function (o) {
      o.units.forEach(function (x) { if (x.status === 'frei') freie.push({ o: o, x: x }); });
    });
    if (!freie.length) return '';
    return '<div class="tafel"><h3>Freie Einheiten <span class="anzahl">' + freie.length + '</span></h3>'
      + freie.map(function (r) {
          return '<div class="faellig">'
            + '<div class="fpunkt" style="background:var(--frei)"></div>'
            + '<div class="fgrow klickbar" data-act="edit-unit" data-oid="' + r.o.id + '" data-uid="' + r.x.id + '">'
            + '<div class="fwas">' + esc(r.x.name) + '</div>'
            + '<div class="fobj">' + esc(r.o.name.split(',')[0])
            + (netto(r.x) ? ' · ' + money(netto(r.x)) + ' netto' : '') + '</div></div>'
            + '<button class="tiny" data-act="interessent-fuer" data-uid="' + r.x.id + '">Vormerken</button>'
            + '</div>';
        }).join('')
      + '</div>';
  }

  function interessentenAbschnitt() {
    let html = '';
      const alle = data.interessenten || [];
      const passtI = function (i) {
        if (!query) return true;
        const q = query.toLowerCase();
        return (i.name + ' ' + (i.kontakt || '') + ' ' + einheitKurz(i.einheitId) + ' ' + (i.notiz || ''))
          .toLowerCase().indexOf(q) !== -1;
      };
      const aktive = alle.filter(function (i) { return i.status !== 'absage' && passtI(i); });
      const absagen = alle.filter(function (i) { return i.status === 'absage' && passtI(i); });
      const reihen = { neu: 0, besichtigung: 1, auskunft: 2, zusage: 3, absage: 4 };
      const sortiert = function (a, c) {
        if (reihen[a.status] !== reihen[c.status]) return reihen[a.status] - reihen[c.status];
        if (a.termin !== c.termin) return (a.termin || '9999') < (c.termin || '9999') ? -1 : 1;
        return (a.name || '').localeCompare(c.name || '');
      };
      const weiterKnopf = function (i) {
        return IFOLGE[i.status]
          ? '<button class="tiny ghost iweiter" data-act="interessent-weiter" data-id="' + i.id
            + '" title="Weiter zu: ' + istatusName(IFOLGE[i.status]) + '">→</button>'
          : '';
      };

      html += '<div class="tafel"><h3>Interessenten'
        + (aktive.length ? '<span class="anzahl">' + aktive.length + '</span>' : '')
        + '<span class="zeitraum"><button class="tiny ghost" data-act="interessent-neu">+ Neu</button></span>'
        + '</h3>';

      if (!alle.length) {
        html += '<div class="unit-type">Noch niemand vorgemerkt. Anfragen aus der Post landen mit „Interessent" direkt hier — oder oben mit „+ Neu" anlegen.</div>';
      } else if (!aktive.length && !absagen.length) {
        html += '<div class="unit-type">Keine Treffer für die Suche.</div>';
      } else if (mobil) {
        const gruppen = {};
        aktive.forEach(function (i) {
          const k = i.einheitId || '';
          (gruppen[k] = gruppen[k] || []).push(i);
        });
        Object.keys(gruppen).sort(function (a, c) {
          if (!a) return 1; if (!c) return -1;
          return einheitKurz(a).localeCompare(einheitKurz(c));
        }).forEach(function (k) {
          html += '<div class="hblock"><strong>' + esc(k ? einheitKurz(k) : 'Ohne Wohnung') + '</strong>'
            + gruppen[k].sort(sortiert).map(function (i) {
                return '<div class="faellig klickbar" data-act="interessent-oeffnen" data-id="' + i.id + '">'
                  + '<div class="fpunkt istat-' + i.status + '"></div>'
                  + '<div class="fgrow"><div class="fwas">' + esc(i.name || 'Ohne Name') + '</div>'
                  + '<div class="fobj">' + istatusName(i.status)
                  + (i.termin ? ' · <span class="' + (terminHeute(i.termin) ? 'iheut' : '') + '">'
                      + esc(terminText(i.termin)) + '</span>' : '')
                  + '</div></div>'
                  + weiterKnopf(i)
                  + '</div>';
              }).join('')
            + '</div>';
        });
      } else {
        html += '<div class="ipipeline">';
        ISTATUS.slice(0, 4).forEach(function (st) {
          const drin = aktive.filter(function (i) { return i.status === st[0]; }).sort(sortiert);
          html += '<div class="ispalte"><strong>' + st[1]
            + (drin.length ? ' <span class="anzahl">' + drin.length + '</span>' : '') + '</strong>'
            + (drin.length ? drin.map(function (i) {
                return '<div class="ikarte klickbar" data-act="interessent-oeffnen" data-id="' + i.id + '">'
                  + '<div class="ikopf"><span class="iname">' + esc(i.name || 'Ohne Name') + '</span>' + weiterKnopf(i) + '</div>'
                  + (i.einheitId ? '<div class="imeta">' + esc(einheitKurz(i.einheitId)) + '</div>' : '')
                  + (i.termin ? '<div class="imeta' + (terminHeute(i.termin) ? ' iheut' : '') + '">'
                      + esc(terminText(i.termin)) + '</div>' : '')
                  + '</div>';
              }).join('') : '<div class="ileer">—</div>')
            + '</div>';
        });
        html += '</div>';
      }

      if (absagen.length) {
        html += '<div class="iabsagen"><button class="tiny ghost" data-act="interessent-absagen">'
          + absagen.length + (absagen.length === 1 ? ' Absage ' : ' Absagen ')
          + (absagenOffen ? 'ausblenden' : 'anzeigen') + '</button>'
          + (absagenOffen ? absagen.map(function (i) {
              return '<div class="faellig klickbar" data-act="interessent-oeffnen" data-id="' + i.id + '">'
                + '<div class="fpunkt istat-absage"></div>'
                + '<div class="fgrow"><div class="fwas">' + esc(i.name || 'Ohne Name') + '</div>'
                + '<div class="fobj">' + esc(einheitKurz(i.einheitId) || '') + '</div></div></div>';
            }).join('') : '')
          + '</div>';
      }
      html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------
  //  Rechnungen — Allgemeinstrom aus der PV-Anlage, gestellt an den Eigentümer
  // ---------------------------------------------------------------
  const RG_STAMM_LEER = { name: '', strasse: '', ort: '', steuernummer: '', ustId: '',
    kontoinhaber: '', iban: '', bank: '', kontakt: '',
    empfaenger: 'Michael Ziegler\nSonnenmeiler 18\n71409 Schwaikheim' };

  function rgHeute() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function rgDatum(w) {
    return w && /^\d{4}-\d{2}-\d{2}/.test(w) ? w.slice(8, 10) + '.' + w.slice(5, 7) + '.' + w.slice(0, 4) : '';
  }
  function rgZahl(v) { return parseFloat(String(v == null ? '' : v).replace(',', '.')) || 0; }
  function rgEur(v) { return n(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  function rgKwh(v) { return n(v).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function rgCt(v) { return n(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function rgStamm() { return (rg && rg.stamm) || RG_STAMM_LEER; }

  function rgObjektStandard() {
    const t = data.objects.find(function (o) { return /tribergle/i.test(o.name); });
    return (t || data.objects[0] || { name: '' }).name;
  }

  // Was die Rechnungsarten unterscheidet: Kürzel, Name und die Texte auf dem Blatt
  const RG_ARTEN = {
    as: { kuerzel: 'AS', name: 'Allgemeinstrom', zaehler: 'Allgemeinstromzähler',
      betreff: 'Rechnung über Stromlieferung für den Allgemeinbedarf',
      einleitung: function (z, o) { return 'Für den im Zeitraum ' + z + ' gelieferten Strom für den Allgemeinbedarf der Liegenschaft ' + o + ' berechne ich wie folgt:'; },
      posten: 'Lieferung Allgemeinstrom' },
    pv: { kuerzel: 'PV', name: 'Solarstrom', zaehler: 'PV-Zähler',
      betreff: 'Rechnung über die Lieferung von Solarstrom',
      einleitung: function (z, o) { return 'Für den im Zeitraum ' + z + ' aus der Photovoltaikanlage der Liegenschaft ' + o + ' gelieferten Solarstrom berechne ich wie folgt:'; },
      posten: 'Lieferung Solarstrom' }
  };
  function rgArt(f) { return RG_ARTEN[(f && f.art) || 'as'] ? (f && f.art) || 'as' : 'as'; }

  function rgNeu(art) {
    art = RG_ARTEN[art] ? art : 'as';
    const jahr = new Date().getFullYear();
    rgForm = {
      id: null, art: art,
      objekt: rgObjektStandard(),
      von: jahr + '-01-01', bis: jahr + '-12-31',
      zaehler: '', standAlt: '', standNeu: '', menge: '',
      preis: '', ustSatz: '19',
      extraText: '', extraBetrag: '',
      nummer: (rg && rg.naechste && rg.naechste[art]) || (jahr + '-' + RG_ARTEN[art].kuerzel + '-01'),
      datum: rgHeute(), frist: '14',
      empfaenger: rgStamm().empfaenger || ''
    };
    // Solarstrom wird einmal im Jahr fürs Vorjahr abgerechnet: aus der letzten Rechnung weitermachen
    if (art === 'pv') {
      const letzte = rg && rg.liste.filter(function (e) { return e.art === 'pv'; })
        .sort(function (a, b) { return String(b.inhalt && b.inhalt.bis || b.datum).localeCompare(String(a.inhalt && a.inhalt.bis || a.datum)); })[0];
      if (letzte) rgFolgejahr(letzte);
      else { rgForm.von = (jahr - 1) + '-01-01'; rgForm.bis = (jahr - 1) + '-12-31'; }
    }
  }

  // Aus einer gespeicherten Rechnung die fürs nächste Jahr vorbereiten:
  // Zeitraum ein Jahr weiter, alter Stand = letzter neuer Stand, Preis und Empfänger bleiben
  function rgFolgejahr(e) {
    const alt = e.inhalt || {};
    const art = RG_ARTEN[e.art] ? e.art : 'as';
    const plusJahr = function (d) {
      return /^\d{4}-/.test(d || '') ? (Number(d.slice(0, 4)) + 1) + d.slice(4) : d;
    };
    rgForm = Object.assign({}, alt, {
      id: null, art: art,
      objekt: e.objekt || alt.objekt,
      von: plusJahr(alt.von), bis: plusJahr(alt.bis),
      standAlt: alt.standNeu || '', standNeu: '', menge: '',
      nummer: (rg && rg.naechste && rg.naechste[art]) || '',
      datum: rgHeute()
    });
  }

  async function rgLaden() {
    try {
      const e = await api('rechnungen');
      rg = { stamm: Object.assign({}, RG_STAMM_LEER, e.stamm || {}),
             nkStamm: Object.assign({}, NK_STAMM_LEER, e.nkStamm || {}),
             liste: e.liste || [], naechste: e.naechste || {} };
      if (!rgForm || (!rgForm.id && rgArt(rgForm) !== (rgTab === 'nk' ? 'as' : rgTab))) rgNeu(rgTab === 'nk' ? 'as' : rgTab);
      else if (!rgForm.id) {
        if (rg.naechste[rgArt(rgForm)]) rgForm.nummer = rg.naechste[rgArt(rgForm)];
        if (!rgForm.empfaenger.trim()) rgForm.empfaenger = rg.stamm.empfaenger;
      }
      if (!nkForm) nkNeu();
      else if (!nkForm.id && rg.naechste.nk) nkForm.nummer = rg.naechste.nk;
      render();
    } catch (e) { toast(e.message); }
  }

  // Alle Beträge aus dem Entwurf: Menge aus den Zählerständen, sonst aus dem Feld
  function rgRechnen(f) {
    const alt = rgZahl(f.standAlt), neu = rgZahl(f.standNeu);
    const mitZaehler = !!(alt || neu);
    const manuell = rgZahl(f.menge);
    const menge = manuell > 0 ? manuell : (mitZaehler && neu ? neu - alt : 0);   // ohne neuen Stand noch nichts rechnen
    const preis = rgZahl(f.preis);
    const strom = Math.round(menge * preis) / 100;
    const extra = Math.round(rgZahl(f.extraBetrag) * 100) / 100;
    const nettoSumme = strom + extra;
    const satz = rgZahl(f.ustSatz);
    const ust = Math.round(nettoSumme * satz) / 100;
    return { alt: alt, neu: neu, mitZaehler: mitZaehler, menge: menge, preis: preis, strom: strom,
      extra: extra, netto: nettoSumme, satz: satz, ust: ust, brutto: nettoSumme + ust };
  }

  function rgSummeHtml(r) {
    return '<span>' + rgKwh(r.menge) + ' kWh × ' + rgCt(r.preis) + ' ct</span><span class="betrag">' + rgEur(r.strom) + '</span>'
      + (r.extra ? '<span>' + esc(rgForm.extraText || 'Weitere Position') + '</span><span class="betrag">' + rgEur(r.extra) + '</span>' : '')
      + '<span>Summe netto</span><span class="betrag">' + rgEur(r.netto) + '</span>'
      + '<span>zzgl. ' + r.satz.toLocaleString('de-DE') + ' % Umsatzsteuer</span><span class="betrag">' + rgEur(r.ust) + '</span>'
      + '<span class="gesamt">Rechnungsbetrag</span><span class="betrag gesamt">' + rgEur(r.brutto) + '</span>';
  }

  function rechnungenAbschnitt() {
    if (!rgForm || rgArt(rgForm) !== rgTab) rgNeu(rgTab);
    const f = rgForm, s = rgStamm();
    const art = RG_ARTEN[rgArt(f)];
    const r = rgRechnen(f);
    const feld = function (key, label, typ, extra) {
      return '<label class="feldchen"><span>' + label + '</span>'
        + '<input type="' + (typ || 'text') + '" data-rg="' + key + '" value="' + esc(f[key]) + '"' + (extra || '') + '></label>';
    };
    const dez = ' step="0.01" inputmode="decimal"';

    const gespeichert = rg ? rg.liste.filter(function (e) { return (e.art || 'as') === rgArt(f); }) : [];
    const offen = rgFormOffen || (rg && !gespeichert.length);
    let html = '';
    if (offen) {
    html += '<div class="tafel rg-form"><h3>' + (f.id ? 'Rechnung ' + esc(f.nummer) : 'Neue Rechnung')
      + ' <span class="anzahl">' + art.name + '</span>'
      + (gespeichert.length ? '<button class="tiny ghost rg-knopf" data-act="rg-zu">Schließen</button>' : '') + '</h3>';
    html += '<div class="rg-grid">'
      + '<label class="feldchen breit"><span>Objekt</span><select data-rg="objekt">'
      + data.objects.map(function (o) {
          return '<option' + (o.name === f.objekt ? ' selected' : '') + '>' + esc(o.name) + '</option>';
        }).join('')
      + '</select></label>'
      + feld('von', 'Zeitraum von', 'date') + feld('bis', 'Zeitraum bis', 'date')
      + '</div>';
    // Drei Blöcke: was verbraucht wurde, was es kostet, und die Angaben der Rechnung selbst
    html += '<div class="rg-gruppe">Verbrauch</div>';
    html += '<div class="rg-zaehler"><div class="rg-grid" style="margin-top:0">'
      + feld('zaehler', 'Zählernummer', 'text', ' placeholder="optional"')
      + feld('standAlt', 'Stand alt (kWh)', 'number', dez)
      + feld('standNeu', 'Stand neu (kWh)', 'number', dez)
      + feld('menge', 'Oder Menge (kWh)', 'number', dez + ' placeholder="ohne Zählerstände"')
      + '</div><div class="rg-kwh"><b id="rg-kwh">' + rgKwh(r.menge) + '</b><span>kWh geliefert</span></div></div>';
    html += '<div class="rg-gruppe">Preis</div>';
    html += '<div class="rg-grid">'
      + feld('preis', 'Arbeitspreis (ct/kWh netto)', 'number', dez + ' placeholder="z. B. 32,04"')
      + feld('ustSatz', 'Umsatzsteuer (%)', 'number', ' step="0.1"')
      + feld('extraText', 'Weitere Position', 'text', ' placeholder="z. B. Zählermiete"')
      + feld('extraBetrag', 'Betrag (€ netto)', 'number', dez)
      + '</div>';
    html += '<div class="rg-gruppe">Rechnung</div>';
    html += '<div class="rg-grid">'
      + feld('nummer', 'Rechnungsnummer')
      + feld('datum', 'Rechnungsdatum', 'date')
      + feld('frist', 'Zahlungsziel (Tage)', 'number', ' step="1"')
      + '<label class="feldchen breit"><span>Empfänger</span><textarea data-rg="empfaenger" rows="3">' + esc(f.empfaenger) + '</textarea></label>'
      + '</div>';
    html += '<div class="rg-summe" id="rg-summe">' + rgSummeHtml(r) + '</div>';
    html += '<div class="modal-actions" style="margin-top:14px">'
      + '<span class="spacer"></span>'
      + '<button data-act="rg-vorschau">Vorschau &amp; Drucken</button>'
      + '<button class="primary" data-act="rg-speichern">' + (f.id ? 'Änderung speichern' : 'Speichern') + '</button>'
      + '</div>';
    if (!s.name || !s.iban) {
      html += '<div class="rg-hinweis">Absender, Steuernummer und IBAN fehlen noch — '
        + '<button class="linkknopf" data-act="absender" data-art="rg">jetzt eintragen</button>, dann stehen sie auf jeder Rechnung.</div>';
    }
    html += '</div>';
    }

    html += '<div class="tafel rg-liste"><h3>' + art.name + '-Rechnungen'
      + (gespeichert.length ? ' <span class="anzahl">' + gespeichert.length + '</span>' : '')
      + (offen && !f.id ? '' : '<button class="tiny primary rg-knopf" data-act="rg-neu" data-art="' + rgArt(f) + '">+ Neue Rechnung</button>')
      + '</h3>';
    if (!rg) html += '<div class="unit-type">Wird geladen …</div>';
    else if (!gespeichert.length) html += '<div class="unit-type">Noch keine Rechnung gespeichert.</div>';
    else gespeichert.forEach(function (e) {
      html += '<div class="zeile"><b class="num">' + esc(e.nummer) + '</b><span>' + esc(e.objekt) + '</span>'
        + '<span class="num">' + rgEur(e.brutto) + '</span>'
        + '<span class="wer">' + rgDatum(e.datum) + (e.wer ? ' · ' + esc(e.wer) : '') + '</span>'
        + '<span class="knoepfe"><button class="tiny" data-act="rg-laden" data-id="' + e.id + '">Öffnen</button>'
        + '<button class="tiny" data-act="rg-folgejahr" data-id="' + e.id + '" title="Neue Rechnung mit den Daten dieser, ein Jahr weiter">Fürs nächste Jahr</button>'
        + '<button class="tiny danger" data-act="rg-loeschen" data-id="' + e.id + '">Löschen</button></span></div>';
    });
    html += '</div>';
    return html;
  }

  // Eingaben landen direkt im Entwurf; nur die Summen werden neu gezeichnet, damit der Cursor bleibt
  function rgBinden() {
    if (ansicht !== 'rechnungen' || !rgForm) return;
    root.querySelectorAll('[data-rg]').forEach(function (el) {
      const los = function () {
        rgForm[el.getAttribute('data-rg')] = el.value;
        const r = rgRechnen(rgForm);
        const k = root.querySelector('#rg-kwh'); if (k) k.textContent = rgKwh(r.menge);
        const su = root.querySelector('#rg-summe'); if (su) su.innerHTML = rgSummeHtml(r);
      };
      el.addEventListener('input', los);
      el.addEventListener('change', los);
    });
  }

  // Absender (Rechnungen) und Vermieter (Nebenkosten) — im Fenster aus dem Menü
  function stammBinden() {
    [['data-rgs', 'stamm'], ['data-nks', 'nkStamm']].forEach(function (a) {
      root.querySelectorAll('[' + a[0] + ']').forEach(function (el) {
        el.addEventListener('input', function () {
          if (!rg) rg = { stamm: Object.assign({}, RG_STAMM_LEER), nkStamm: Object.assign({}, NK_STAMM_LEER), liste: [], naechste: {} };
          rg[a[1]][el.getAttribute(a[0])] = el.value;
        });
      });
    });
  }
  function absenderOeffnen(art) {
    modal = { kind: 'absender', art: art === 'nk' ? 'nk' : 'rg' };
    render(); fensterGeoeffnet();
    if (!rg) rgLaden();
  }
  function absenderFenster() {
    if (!rg) return '<h2>Einen Moment …</h2>';
    if (modal.art === 'nk') {
      const s = nkStamm();
      const sf = function (key, label) {
        return '<label class="feldchen"><span>' + label + '</span><input type="text" data-nks="' + key + '" value="' + esc(s[key]) + '"></label>';
      };
      return '<h2>Vermieter für Nebenkosten</h2>'
        + '<div class="rg-grid">' + sf('vermieter', 'Vermieter') + sf('strasse', 'Straße') + sf('ort', 'PLZ und Ort')
        + sf('telefon', 'Telefon für Rückfragen') + sf('unterschrift', 'Unterschrift') + sf('kontoText', 'Konto-Hinweis bei Nachzahlung')
        + sf('anlage', 'Anlage (Vorgabe)') + '</div>'
        + '<div class="modal-actions"><div class="spacer"></div><button data-act="close">Abbrechen</button>'
        + '<button class="primary" data-act="nk-stamm-speichern">Speichern</button></div>';
    }
    const s = rgStamm();
    const sf = function (key, label) {
      return '<label class="feldchen"><span>' + label + '</span><input type="text" data-rgs="' + key + '" value="' + esc(s[key]) + '"></label>';
    };
    return '<h2>Rechnungsabsender</h2>'
      + '<div class="rg-grid">'
      + sf('name', 'Name') + sf('strasse', 'Straße') + sf('ort', 'PLZ und Ort')
      + sf('steuernummer', 'Steuernummer') + sf('ustId', 'USt-IdNr. (falls vorhanden)')
      + sf('kontoinhaber', 'Kontoinhaber') + sf('iban', 'IBAN') + sf('bank', 'Bank') + sf('kontakt', 'Telefon / E-Mail')
      + '<label class="feldchen breit"><span>Empfänger (Vorgabe für neue Rechnungen)</span>'
      + '<textarea data-rgs="empfaenger" rows="3">' + esc(s.empfaenger) + '</textarea></label>'
      + '</div><div class="modal-actions"><div class="spacer"></div><button data-act="close">Abbrechen</button>'
      + '<button class="primary" data-act="rg-stamm-speichern">Speichern</button></div>';
  }

  async function rgStammSpeichern() {
    try {
      const e = await api('rechnungen/absender', { method: 'PUT', body: rgStamm() });
      rg.stamm = Object.assign({}, RG_STAMM_LEER, e.stamm || {});
      if (modal && modal.kind === 'absender') modal = null;
      if (rgForm && !rgForm.id && !rgForm.empfaenger.trim()) rgForm.empfaenger = rg.stamm.empfaenger;
      toast('Absender gespeichert'); render();
    } catch (e) { toast(e.message); }
  }

  async function rgSpeichern() {
    const f = rgForm, r = rgRechnen(f);
    if (!f.nummer.trim()) { toast('Rechnungsnummer fehlt'); return; }
    if (!r.menge) { toast('Menge fehlt — Zählerstände oder kWh eintragen'); return; }
    if (!r.preis) { toast('Arbeitspreis fehlt'); return; }
    try {
      const e = await api('rechnungen', { method: 'POST',
        body: { id: f.id, art: rgArt(f), nummer: f.nummer.trim(), objekt: f.objekt, datum: f.datum, brutto: r.brutto, inhalt: f } });
      if (!rg) rg = { stamm: Object.assign({}, RG_STAMM_LEER), nkStamm: Object.assign({}, NK_STAMM_LEER), liste: [], naechste: {} };
      rg.liste = e.liste; rg.naechste = e.naechste;
      rgForm.id = e.id;
      rgFormOffen = true;   // die eben gespeicherte Rechnung bleibt offen
      toast('Rechnung ' + f.nummer + ' gespeichert'); render();
    } catch (err) { toast(err.message); }
  }

  function rgAusListe(id) {
    const e = rg && rg.liste.find(function (x) { return String(x.id) === String(id); });
    if (!e) return;
    rgForm = Object.assign({}, e.inhalt || {}, { id: e.id, art: e.art || 'as', nummer: e.nummer, objekt: e.objekt, datum: e.datum });
    if (!rgForm.empfaenger) rgForm.empfaenger = '';
    rgFormOffen = true;
    render(); window.scrollTo(0, 0);
  }

  async function rgLoeschen(id, art) {
    const e = rg && rg.liste.find(function (x) { return String(x.id) === String(id); });
    if (!e) return;
    const vorher = rg.liste;
    rg.liste = rg.liste.filter(function (x) { return String(x.id) !== String(id); });
    render();
    spaeterLoeschen((art === 'nk' ? 'Schreiben ' : 'Rechnung ') + e.nummer + ' gelöscht', async function () {
      try {
        const a = await api('rechnungen/' + id, { method: 'DELETE' });
        rg.liste = a.liste; rg.naechste = a.naechste;
        if (rgForm && String(rgForm.id) === String(id)) rgNeu(rgArt(rgForm));
        if (nkForm && String(nkForm.id) === String(id)) nkNeu();
        render();
      } catch (err) { rg.liste = vorher; fehlerToast(err.message); render(); }
    }, function () { rg.liste = vorher; render(); toast('Wiederhergestellt'); });
  }

  // Das fertige Blatt (DIN A4) — dieselbe Ansicht für Vorschau und Druck
  function rgBlattHtml(f, s) {
    const r = rgRechnen(f);
    const art = RG_ARTEN[rgArt(f)];
    const zeitraum = rgDatum(f.von) + ' – ' + rgDatum(f.bis);
    const absender = [s.name, s.strasse, s.ort].filter(Boolean).map(esc).join(' · ');
    const steuer = s.ustId ? ['USt-IdNr.', s.ustId] : ['Steuernummer', s.steuernummer];
    const meta = [['Rechnungsnummer', f.nummer], ['Rechnungsdatum', rgDatum(f.datum)],
        ['Leistungszeitraum', zeitraum], ['Objekt', f.objekt], steuer]
      .filter(function (z) { return z[1]; })
      .map(function (z) { return '<div><span>' + esc(z[0]) + '</span><span>' + esc(z[1]) + '</span></div>'; }).join('');
    const faellig = new Date((f.datum || rgHeute()) + 'T12:00:00');
    faellig.setDate(faellig.getDate() + (rgZahl(f.frist) || 14));
    const faelligText = faellig.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const konto = [s.kontoinhaber || s.name, s.iban, s.bank].filter(Boolean).map(esc).join(' · ');
    return '<div class="absenderzeile">' + (absender || 'Absender fehlt — unter Rechnungen › Absender eintragen') + '</div>'
      + '<div class="anschrift"><div class="empf">' + esc(f.empfaenger) + '</div><div class="meta">' + meta + '</div></div>'
      + '<h2 class="betreff">' + art.betreff + ' – ' + esc(f.objekt) + '</h2>'
      + '<p>' + art.einleitung(zeitraum, esc(f.objekt)) + '</p>'
      + (r.mitZaehler
          ? '<table class="stand"><tr><th>Zähler</th><th>Stand alt</th><th>Stand neu</th><th>Verbrauch</th></tr>'
            + '<tr><td>' + esc(f.zaehler || art.zaehler) + '</td><td>' + rgKwh(r.alt) + ' kWh</td>'
            + '<td>' + rgKwh(r.neu) + ' kWh</td><td>' + rgKwh(r.neu - r.alt) + ' kWh</td></tr></table>'
          : '')
      + '<table class="posten"><tr><th>Leistung</th><th class="z">Menge</th><th class="z">Einzelpreis</th><th class="z">Betrag netto</th></tr>'
      + '<tr><td>' + art.posten + '<span class="klein">Abrechnungszeitraum ' + zeitraum + '</span></td>'
      + '<td class="z">' + rgKwh(r.menge) + ' kWh</td><td class="z">' + rgCt(r.preis) + ' ct/kWh</td><td class="z">' + rgEur(r.strom) + '</td></tr>'
      + (r.extra || f.extraText
          ? '<tr><td>' + esc(f.extraText || 'Weitere Position') + '</td><td class="z">1</td>'
            + '<td class="z">' + rgEur(r.extra) + '</td><td class="z">' + rgEur(r.extra) + '</td></tr>'
          : '')
      + '</table>'
      + '<table class="summen"><tr><td>Summe netto</td><td>' + rgEur(r.netto) + '</td></tr>'
      + (r.satz
          ? '<tr><td>zzgl. ' + r.satz.toLocaleString('de-DE') + ' % Umsatzsteuer</td><td>' + rgEur(r.ust) + '</td></tr>'
          : '')
      + '<tr class="gesamt"><td>Rechnungsbetrag</td><td>' + rgEur(r.brutto) + '</td></tr></table>'
      + (r.satz ? '' : '<p class="klein">Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.</p>')
      + '<p class="zahlung">Bitte überweisen Sie den Rechnungsbetrag von <b>' + rgEur(r.brutto) + '</b> bis zum <b>'
      + faelligText + '</b> unter Angabe der Rechnungsnummer ' + esc(f.nummer) + '.'
      + (konto ? '<br>' + konto : '') + '</p>'
      + '<p class="gruss">Mit freundlichen Grüßen</p><p class="unterschrift">' + esc(s.name) + '</p>'
      + '<div class="fuss">' + [absender, esc(s.kontakt),
          s.steuernummer ? 'Steuernummer ' + esc(s.steuernummer) : '',
          s.iban ? 'IBAN ' + esc(s.iban) : '']
        .filter(Boolean).map(function (t) { return '<span>' + t + '</span>'; }).join('') + '</div>';
  }

  function rgVorschau(titel, blatt) {
    const dk = document.getElementById('druck');
    if (!dk) return;
    if (!titel) { if (!rgForm) return; titel = 'Rechnung ' + rgForm.nummer; blatt = rgBlattHtml(rgForm, rgStamm()); }
    dk.innerHTML = '<div class="dk-leiste"><span>' + esc(titel) + '</span>'
      + '<button type="button" data-dk="zu">Schließen</button>'
      + '<button type="button" class="primary" data-dk="drucken">Drucken / PDF</button></div>'
      + '<div class="blatt">' + blatt + '</div>';
    dk.hidden = false;
    dk.scrollTop = 0;
    dk.querySelector('[data-dk="zu"]').addEventListener('click', rgVorschauZu);
    dk.querySelector('[data-dk="drucken"]').addEventListener('click', function () { window.print(); });
  }
  function rgVorschauZu() {
    const dk = document.getElementById('druck');
    if (!dk) return;
    dk.hidden = true; dk.innerHTML = '';
  }

  // ---------------------------------------------------------------
  //  Nebenkosten — das Anschreiben an den Mieter zur Jahresabrechnung
  // ---------------------------------------------------------------
  const NK_STAMM_LEER = { vermieter: 'Michael Ziegler', strasse: 'Sonnenmeiler 18', ort: '71409 Schwaikheim',
    telefon: '', unterschrift: 'I.A. Louis Ziegler', kontoText: 'auf das Ihnen bekannte Konto',
    anlage: 'Einzelabrechnung Heiz-, Wasser- und Betriebskosten' };

  function nkStamm() { return (rg && rg.nkStamm) || NK_STAMM_LEER; }

  function nkNachname(name) {
    const erster = String(name || '').split(/[,&\/]| und /)[0].trim();
    const teile = erster.split(/\s+/).filter(Boolean);
    return teile.length ? teile[teile.length - 1] : '';
  }
  function nkDatumPlus(iso, tage) {
    const d = new Date((iso || rgHeute()) + 'T12:00:00');
    d.setDate(d.getDate() + tage);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function nkNeu() {
    const jahr = new Date().getFullYear() - 1;   // abgerechnet wird das Vorjahr
    const o = data.objects.find(function (x) { return /tribergle/i.test(x.name); }) || data.objects[0];
    nkForm = {
      id: null, nummer: (rg && rg.naechste && rg.naechste.nk) || ((jahr + 1) + '-NK-01'),
      objektId: o ? o.id : '', objekt: o ? o.name : '', einheitId: '',
      mieter: '', wohnung: '', anredeArt: 'Frau', anredeName: '',
      von: jahr + '-01-01', bis: jahr + '-12-31', datum: rgHeute(), zahlbarBis: nkDatumPlus(rgHeute(), 30),
      betrag: '', posten: [], vzMonat: '', vzMonate: '12',
      guthabenWie: 'ueberweisen', anlage: nkStamm().anlage || '', hinweis: ''
    };
    nkEinheitWaehlen(o && o.units.find(function (x) { return x.status === 'vermietet'; }) ? o.units.find(function (x) { return x.status === 'vermietet'; }).id : '');
  }

  // Einheit gewählt: Mieter, Wohnung und Vorauszahlung aus den Objektdaten übernehmen
  function nkEinheitWaehlen(einheitId) {
    const o = data.objects.find(function (x) { return x.id === nkForm.objektId; });
    const x = o && o.units.find(function (y) { return y.id === einheitId; });
    nkForm.einheitId = x ? x.id : '';
    if (!x) return;
    nkForm.mieter = x.tenant || '';
    nkForm.wohnung = /wohnung|garage|stellplatz|laden|büro|werkstatt/i.test(x.name) ? x.name : 'Wohnung ' + x.name;
    nkForm.anredeName = nkNachname(x.tenant);
    if (x.nk != null && x.nk !== '') nkForm.vzMonat = String(x.nk);
  }

  function nkRechnen(f) {
    const posten = (f.posten || []).map(function (p) { return { text: p.text, betrag: Math.round(rgZahl(p.betrag) * 100) / 100 }; });
    const postenSumme = posten.reduce(function (a, p) { return a + p.betrag; }, 0);
    const mitPosten = posten.some(function (p) { return p.betrag; });
    const betrag = mitPosten ? postenSumme : Math.round(rgZahl(f.betrag) * 100) / 100;
    const vz = Math.round(rgZahl(f.vzMonat) * rgZahl(f.vzMonate) * 100) / 100;
    const diff = Math.round((betrag - vz) * 100) / 100;
    return { posten: posten, mitPosten: mitPosten, betrag: betrag, vz: vz, diff: diff,
      nachzahlung: diff > 0 ? diff : 0, guthaben: diff < 0 ? -diff : 0 };
  }

  function nkSummeHtml(r) {
    return '<span>Nebenkosten gesamt</span><span class="betrag">' + rgEur(r.betrag) + '</span>'
      + '<span>Vorauszahlungen</span><span class="betrag">' + rgEur(r.vz) + '</span>'
      + '<span class="gesamt">' + (r.diff >= 0 ? 'Nachzahlung' : 'Guthaben') + '</span>'
      + '<span class="betrag gesamt">' + rgEur(Math.abs(r.diff)) + '</span>';
  }

  function nkJahr(f) { return (f.von || '').slice(0, 4); }

  function nebenkostenAbschnitt() {
    if (!nkForm) nkNeu();
    const f = nkForm, s = nkStamm(), r = nkRechnen(f);
    const o = data.objects.find(function (x) { return x.id === f.objektId; });
    const feld = function (key, label, typ, extra) {
      return '<label class="feldchen"><span>' + label + '</span>'
        + '<input type="' + (typ || 'text') + '" data-nk="' + key + '" value="' + esc(f[key]) + '"' + (extra || '') + '></label>';
    };
    const dez = ' step="0.01" inputmode="decimal"';

    const gespeichert = rg ? rg.liste.filter(function (e) { return e.art === 'nk'; }) : [];
    const offen = nkFormOffen || (rg && !gespeichert.length);
    let html = '';
    if (offen) {
    html += '<div class="tafel rg-form"><h3>' + (f.id ? 'Schreiben ' + esc(f.nummer) : 'Neues Schreiben')
      + ' <span class="anzahl">Nebenkosten ' + esc(nkJahr(f)) + '</span>'
      + (gespeichert.length ? '<button class="tiny ghost rg-knopf" data-act="nk-zu">Schließen</button>' : '') + '</h3>';
    html += '<div class="rg-grid">'
      + '<label class="feldchen"><span>Objekt</span><select data-nk="objektId">'
      + data.objects.map(function (x) { return '<option value="' + x.id + '"' + (x.id === f.objektId ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('')
      + '</select></label>'
      + '<label class="feldchen"><span>Einheit</span><select data-nk="einheitId"><option value="">— wählen —</option>'
      + (o ? o.units.map(function (x) {
          return '<option value="' + x.id + '"' + (x.id === f.einheitId ? ' selected' : '') + '>' + esc(x.name)
            + (x.tenant ? ' — ' + esc(x.tenant) : '') + '</option>';
        }).join('') : '')
      + '</select></label>'
      + feld('mieter', 'Mieter (Name)') + feld('wohnung', 'Bezeichnung')
      + '<label class="feldchen"><span>Anrede</span><select data-nk="anredeArt">'
      + [['Frau', 'Sehr geehrte Frau'], ['Herr', 'Sehr geehrter Herr'], ['Familie', 'Sehr geehrte Familie'],
         ['Eheleute', 'Sehr geehrte Eheleute'], ['neutral', 'Sehr geehrte Damen und Herren']].map(function (a) {
          return '<option value="' + a[0] + '"' + (a[0] === f.anredeArt ? ' selected' : '') + '>' + a[1] + '</option>';
        }).join('') + '</select></label>'
      + feld('anredeName', 'Nachname in der Anrede')
      + feld('von', 'Zeitraum von', 'date') + feld('bis', 'Zeitraum bis', 'date')
      + feld('datum', 'Datum des Schreibens', 'date') + feld('zahlbarBis', 'Zahlbar bis', 'date')
      + '</div>';

    html += '<div class="rg-zaehler"><div class="rg-grid" style="margin-top:0">'
      + feld('betrag', 'Nebenkosten gesamt (€)', 'number', dez + (r.mitPosten ? ' disabled' : '') + ' placeholder="laut Abrechnung"')
      + feld('vzMonat', 'Vorauszahlung je Monat (€)', 'number', dez)
      + feld('vzMonate', 'Anzahl Monate', 'number', ' step="1"')
      + '</div>'
      + '<div class="nk-posten"><div class="unit-type">Einzelne Kostenarten sind freiwillig — wenn welche eingetragen sind, ergibt sich der Gesamtbetrag daraus.</div>';
    f.posten.forEach(function (p, i) {
      html += '<div class="zeile"><input type="text" data-nkp="' + i + ':text" value="' + esc(p.text) + '" placeholder="Kostenart">'
        + '<input type="number"' + dez + ' data-nkp="' + i + ':betrag" value="' + esc(p.betrag) + '" placeholder="€">'
        + '<button class="tiny ghost" data-act="nk-posten-weg" data-i="' + i + '" title="Zeile entfernen">✕</button></div>';
    });
    html += '<button class="tiny" data-act="nk-posten-neu" style="margin-top:6px">+ Kostenart</button></div>'
      + '<div class="rg-kwh"><b id="nk-diff">' + rgEur(Math.abs(r.diff)) + '</b><span id="nk-diff-art">' + (r.diff >= 0 ? 'Nachzahlung' : 'Guthaben') + '</span></div></div>';

    html += '<div class="feldchen" style="margin-top:12px"><span>Bei Guthaben</span><div class="rg-wahl">'
      + '<button data-act="nk-guthaben" data-w="ueberweisen" class="' + (f.guthabenWie === 'ueberweisen' ? 'aktiv' : '') + '">wird überwiesen</button>'
      + '<button data-act="nk-guthaben" data-w="verrechnen" class="' + (f.guthabenWie === 'verrechnen' ? 'aktiv' : '') + '">mit nächster Miete verrechnet</button>'
      + '</div></div>';
    html += '<div class="rg-grid">' + feld('anlage', 'Anlage (leer = keine Zeile)')
      + '<label class="feldchen breit"><span>Zusätzlicher Hinweis (optional)</span><textarea data-nk="hinweis" rows="2">' + esc(f.hinweis) + '</textarea></label></div>';
    html += '<div class="rg-summe" id="nk-summe">' + nkSummeHtml(r) + '</div>';
    html += '<div class="modal-actions" style="margin-top:14px">'
      + '<span class="spacer"></span>'
      + '<button data-act="nk-vorschau">Vorschau &amp; Drucken</button>'
      + '<button class="primary" data-act="nk-speichern">' + (f.id ? 'Änderung speichern' : 'Speichern') + '</button>'
      + '</div></div>';

    if (!s.vermieter) {
      html += '<div class="rg-hinweis">Vermieter und Unterschrift fehlen noch — '
        + '<button class="linkknopf" data-act="absender" data-art="nk">jetzt eintragen</button>.</div>';
    }
    }

    html += '<div class="tafel rg-liste"><h3>Nebenkosten-Schreiben'
      + (gespeichert.length ? ' <span class="anzahl">' + gespeichert.length + '</span>' : '')
      + (offen && !f.id ? '' : '<button class="tiny primary rg-knopf" data-act="nk-neu">+ Neues Schreiben</button>')
      + '</h3>';
    if (!rg) html += '<div class="unit-type">Wird geladen …</div>';
    else if (!gespeichert.length) html += '<div class="unit-type">Noch kein Schreiben gespeichert.</div>';
    else gespeichert.forEach(function (e) {
      const i = e.inhalt || {};
      html += '<div class="zeile"><b>' + esc(i.mieter || e.nummer) + '</b><span>' + esc(e.objekt) + (i.wohnung ? ' · ' + esc(i.wohnung) : '') + '</span>'
        + '<span class="num">' + (e.brutto >= 0 ? 'Nachzahlung ' : 'Guthaben ') + rgEur(Math.abs(e.brutto)) + '</span>'
        + '<span class="wer">Nebenkosten ' + esc(nkJahr(i)) + ' · ' + rgDatum(e.datum) + '</span>'
        + '<span class="knoepfe"><button class="tiny" data-act="nk-laden" data-id="' + e.id + '">Öffnen</button>'
        + '<button class="tiny danger" data-act="nk-loeschen" data-id="' + e.id + '">Löschen</button></span></div>';
    });
    html += '</div>';
    return html;
  }

  function nkBinden() {
    if (ansicht !== 'rechnungen' || rgTab !== 'nk' || !nkForm) return;
    const frisch = function () {
      const r = nkRechnen(nkForm);
      const d = root.querySelector('#nk-diff'); if (d) d.textContent = rgEur(Math.abs(r.diff));
      const a = root.querySelector('#nk-diff-art'); if (a) a.textContent = r.diff >= 0 ? 'Nachzahlung' : 'Guthaben';
      const su = root.querySelector('#nk-summe'); if (su) su.innerHTML = nkSummeHtml(r);
    };
    root.querySelectorAll('[data-nk]').forEach(function (el) {
      const key = el.getAttribute('data-nk');
      const los = function () {
        if (key === 'objektId') {
          nkForm.objektId = el.value;
          const o = data.objects.find(function (x) { return x.id === el.value; });
          nkForm.objekt = o ? o.name : '';
          nkEinheitWaehlen('');
          render(); return;
        }
        if (key === 'einheitId') { nkEinheitWaehlen(el.value); render(); return; }
        nkForm[key] = el.value;
        if (key === 'datum') {
          nkForm.zahlbarBis = nkDatumPlus(el.value, 30);
          const z = root.querySelector('[data-nk="zahlbarBis"]'); if (z) z.value = nkForm.zahlbarBis;
        }
        frisch();
      };
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', los);
    });
    root.querySelectorAll('[data-nkp]').forEach(function (el) {
      el.addEventListener('input', function () {
        const t = el.getAttribute('data-nkp').split(':');
        const p = nkForm.posten[Number(t[0])];
        if (!p) return;
        p[t[1]] = el.value;
        const r = nkRechnen(nkForm);
        const b = root.querySelector('[data-nk="betrag"]');
        if (b) { b.disabled = r.mitPosten; if (r.mitPosten) b.value = r.betrag.toFixed(2); }
        frisch();
      });
    });
  }

  async function nkStammSpeichern() {
    try {
      const e = await api('rechnungen/absender/nk', { method: 'PUT', body: nkStamm() });
      rg.nkStamm = Object.assign({}, NK_STAMM_LEER, e.stamm || {});
      if (modal && modal.kind === 'absender') modal = null;
      toast('Gespeichert'); render();
    } catch (e) { toast(e.message); }
  }

  async function nkSpeichern() {
    const f = nkForm, r = nkRechnen(f);
    if (!f.mieter.trim()) { toast('Mieter fehlt'); return; }
    if (!r.betrag) { toast('Nebenkostenbetrag fehlt'); return; }
    try {
      const e = await api('rechnungen', { method: 'POST',
        body: { id: f.id, art: 'nk', nummer: f.nummer, objekt: f.objekt, datum: f.datum, brutto: r.diff, inhalt: f } });
      rg.liste = e.liste; rg.naechste = e.naechste;
      nkForm.id = e.id;
      nkFormOffen = true;
      toast('Schreiben für ' + f.mieter + ' gespeichert'); render();
    } catch (err) { toast(err.message); }
  }

  function nkAusListe(id) {
    const e = rg && rg.liste.find(function (x) { return String(x.id) === String(id); });
    if (!e) return;
    nkForm = Object.assign({ posten: [], hinweis: '', anlage: '' }, e.inhalt || {}, { id: e.id, nummer: e.nummer, objekt: e.objekt, datum: e.datum });
    nkFormOffen = true;
    render(); window.scrollTo(0, 0);
  }

  function nkAnrede(f) {
    const n = (f.anredeName || '').trim();
    if (f.anredeArt === 'neutral' || !n) return 'Sehr geehrte Damen und Herren,';
    if (f.anredeArt === 'Herr') return 'Sehr geehrter Herr ' + n + ',';
    if (f.anredeArt === 'Familie') return 'Sehr geehrte Familie ' + n + ',';
    if (f.anredeArt === 'Eheleute') return 'Sehr geehrte Eheleute ' + n + ',';
    return 'Sehr geehrte Frau ' + n + ',';
  }

  function nkBlattHtml(f, s) {
    const r = nkRechnen(f);
    const zeitraum = rgDatum(f.von) + ' – ' + rgDatum(f.bis);
    const jahr = nkJahr(f);
    const ortszeile = (f.objekt || '').split(',').map(function (t) { return t.trim(); });
    const anschrift = [f.mieter, f.wohnung].concat(ortszeile).filter(Boolean).map(esc).join('\n');
    const absender = [s.vermieter, s.strasse, s.ort].filter(Boolean).map(esc).join(' · ');
    const meta = [['Objekt', f.objekt], ['Abrechnungszeitraum', zeitraum], ['Datum', rgDatum(f.datum)]]
      .map(function (z) { return '<div><span>' + esc(z[0]) + '</span><span>' + esc(z[1]) + '</span></div>'; }).join('');
    let ergebnis;
    if (r.diff > 0) {
      ergebnis = '<p>Bitte überweisen Sie die Nachzahlung von <b>' + rgEur(r.diff) + '</b> bis zum <b>' + rgDatum(f.zahlbarBis) + '</b> '
        + esc(s.kontoText || 'auf das Ihnen bekannte Konto') + '.</p>';
    } else if (r.diff < 0) {
      ergebnis = f.guthabenWie === 'verrechnen'
        ? '<p>Ihr Guthaben von <b>' + rgEur(-r.diff) + '</b> wird mit der nächsten Mietzahlung verrechnet.</p>'
        : '<p>Ihr Guthaben von <b>' + rgEur(-r.diff) + '</b> wird in den nächsten Tagen auf Ihr Konto überwiesen.</p>';
    } else {
      ergebnis = '<p>Die Vorauszahlungen decken die Nebenkosten genau ab — es ergibt sich weder eine Nachzahlung noch ein Guthaben.</p>';
    }
    return '<div class="absenderzeile">' + absender + '</div>'
      + '<div class="anschrift"><div class="empf">' + anschrift + '</div><div class="meta">' + meta + '</div></div>'
      + '<h2 class="betreff">Nebenkostenabrechnung ' + esc(jahr) + '</h2>'
      + '<p>' + esc(nkAnrede(f)) + '</p>'
      + '<p>anbei erhalten Sie die Nebenkostenabrechnung für den Zeitraum ' + zeitraum + '.</p>'
      + (r.mitPosten
          ? '<table class="nk-posten"><tr><th>Kostenart</th><th>Betrag</th></tr>'
            + r.posten.filter(function (p) { return p.text || p.betrag; }).map(function (p) {
                return '<tr><td>' + esc(p.text || '—') + '</td><td>' + rgEur(p.betrag) + '</td></tr>';
              }).join('') + '</table>'
          : '')
      + '<table class="nk-tabelle">'
      + '<tr><td>Nebenkosten ' + esc(jahr) + '</td><td>' + rgEur(r.betrag) + '</td></tr>'
      + '<tr><td>Vorauszahlungen (' + rgKwh(rgZahl(f.vzMonate)) + ' × ' + rgEur(rgZahl(f.vzMonat)) + ')</td><td>' + rgEur(r.vz) + '</td></tr>'
      + '<tr class="ergebnis"><td>' + (r.diff >= 0 ? 'Nachzahlung' : 'Guthaben') + '</td><td>' + rgEur(Math.abs(r.diff)) + '</td></tr>'
      + '</table>'
      + ergebnis
      + (f.hinweis && f.hinweis.trim() ? '<p>' + esc(f.hinweis).replace(/\n/g, '<br>') + '</p>' : '')
      + (s.telefon ? '<p>Bei Fragen oder Anmerkungen erreichen Sie mich telefonisch unter ' + esc(s.telefon) + '.</p>' : '')
      + '<p class="gruss">Mit freundlichen Grüßen</p><p class="unterschrift">' + esc(s.unterschrift || s.vermieter) + '</p>'
      + (f.anlage && f.anlage.trim() ? '<div class="anlage">Anlage: ' + esc(f.anlage) + '</div>' : '');
  }

  function nkVorschau() {
    if (!nkForm) return;
    rgVorschau('Nebenkosten ' + nkJahr(nkForm) + ' – ' + (nkForm.mieter || 'Mieter'), nkBlattHtml(nkForm, nkStamm()));
  }

  function mietenAbschnitt() {
    let html = '';
      const alle = [];
      data.objects.forEach(function (o) {
        o.units.forEach(function (x) {
          if (x.status !== 'vermietet' || !soll(x)) return;
          alle.push({ o: o, x: x });
        });
      });
      if (!alle.length) {
        return '<div class="tafel"><h3>Mieten</h3>'
          + '<div class="unit-type">Sobald Einheiten auf „Vermietet" stehen und Beträge eingetragen sind, steht hier die Monatsliste zum Abhaken.</div></div>';
      }

      const md = new Date();
      const mm = new Date(md.getFullYear(), md.getMonth() + mietVersatz, 1);
      const schluessel = mm.getFullYear() + '-' + String(mm.getMonth() + 1).padStart(2, '0');
      const monatName = mm.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

      const zeigen = alle.filter(function (z) { return matches(z.o, z.x); }).map(function (z) {
        const betrag = Math.round(soll(z.x) * 100) / 100;
        const gezahlt = (z.x.zahlungen && z.x.zahlungen[schluessel] != null) ? n(z.x.zahlungen[schluessel]) : null;
        const stand = gezahlt != null && gezahlt >= betrag - 0.005 ? 'ok'
          : (gezahlt != null && gezahlt > 0.005 ? 'teil' : 'offen');
        return { o: z.o, x: z.x, betrag: betrag, gezahlt: gezahlt, stand: stand };
      });
      const offene = zeigen.filter(function (z) { return z.stand !== 'ok'; });
      const offenSumme = offene.reduce(function (a, z) { return a + Math.max(0, z.betrag - n(z.gezahlt)); }, 0);

      html += '<div class="tafel"><h3>Mieten'
        + (zeigen.length
            ? (offene.length
                ? '<span class="anzahl rot">' + offene.length + ' offen</span>'
                : '<span class="anzahl">alle da</span>')
            : '')
        + '<span class="zeitraum">'
        + '<button class="tiny ghost" data-act="miete-monat" data-d="-1"' + (mietVersatz <= -11 ? ' disabled' : '') + '>‹</button>'
        + '<span class="mmonat">' + monatName + '</span>'
        + '<button class="tiny ghost" data-act="miete-monat" data-d="1"' + (mietVersatz >= 0 ? ' disabled' : '') + '>›</button>'
        + (offene.length > 1 && !query
            ? '<span class="trenner"></span><button class="tiny ghost" data-act="miete-alle" data-m="' + schluessel + '">Alle erhalten</button>'
            : '')
        + '</span></h3>';

      if (!zeigen.length) {
        html += '<div class="unit-type">Keine Treffer für die Suche.</div>';
      } else {
        if (offene.length) {
          html += '<div class="unit-type" style="margin-bottom:6px">Noch aussen: '
            + money(offenSumme) + ' aus ' + offene.length
            + (offene.length === 1 ? ' Einheit' : ' Einheiten') + '</div>';
        }
        data.objects.forEach(function (o) {
          const drin = zeigen.filter(function (z) { return z.o.id === o.id; });
          if (!drin.length) return;
          html += '<div class="hblock"><strong>' + esc(o.name.split(',')[0]) + '</strong>'
            + drin.map(function (z) {
                return '<div class="faellig klickbar" data-act="konto" data-id="' + o.id + '">'
                  + '<div class="fpunkt mz-' + z.stand + '"></div>'
                  + '<div class="fgrow"><div class="fwas">' + esc(z.x.name)
                  + (z.x.tenant ? ' · ' + esc(z.x.tenant) : '') + '</div>'
                  + '<div class="fobj">'
                  + (z.stand === 'ok' ? 'bezahlt · ' + money(z.gezahlt)
                      : z.stand === 'teil' ? money(z.gezahlt) + ' von ' + money(z.betrag)
                      : 'offen · ' + money(z.betrag))
                  + '</div></div>'
                  + (z.stand === 'ok'
                      ? '<div class="fwann mzok">✓</div>'
                      : '<button class="tiny" data-act="miete-buchen" data-oid="' + o.id
                        + '" data-uid="' + z.x.id + '" data-m="' + schluessel + '">'
                        + (z.stand === 'teil' ? 'voll' : 'erhalten') + '</button>')
                  + '</div>';
              }).join('')
            + '</div>';
        });
      }
      html += '</div>';
    return html;
  }

  function postAbschnitt() {
    let html = '';
    // ---- Post ----
    if (google.verbunden) {
      html += '<div class="tafel"><h3>Post <span class="anzahl">'
        + (postListe ? postListe.length : '…') + '</span>'
        + '<span class="zeitraum">'
        + '<button class="tiny ghost' + (postModus === 'breit' ? ' aktiv' : '') + '" '
        + 'data-act="post-modus" data-m="breit">Alles</button>'
        + '<button class="tiny ghost' + (postModus === 'streng' ? ' aktiv' : '') + '" '
        + 'data-act="post-modus" data-m="streng">Nur Treffer</button>'
        + '<button class="tiny ghost' + (postModus === 'roh' ? ' aktiv' : '') + '" '
        + 'data-act="post-modus" data-m="roh">Ungefiltert</button>'
        + '<span class="trenner"></span>'
        + '<button class="tiny ghost" data-act="post-frisch" title="Neu bei Google abfragen">↻</button>'
        + '<span class="trenner"></span>'
        + [30, 90, 365].map(function (t) {
            return '<button class="tiny ghost' + (postTage === t ? ' aktiv' : '') + '" '
              + 'data-act="post-tage" data-t="' + t + '">' + (t === 365 ? '1 Jahr' : t + ' Tage') + '</button>';
          }).join('')
        + '</span></h3>';
      if (!postListe) {
        html += '<div class="unit-type">wird geladen …</div>';
      } else if (!postListe.length) {
        html += '<div class="unit-type">Keine Zuordnung möglich'
          + (postInfo && postInfo.geprueft !== undefined
              ? ' — ' + postInfo.geprueft + ' Mails geprüft, ' + postInfo.begriffe + ' Suchbegriffe aus deinen Daten'
              : '')
          + (postInfo && postInfo.fehler ? ': ' + esc(postInfo.fehler) : '') + '.</div>';
        if (postInfo && postInfo.rest && postInfo.rest.length) {
          html += '<div class="modal-actions" style="justify-content:flex-start;margin-top:8px">'
            + '<button class="tiny" data-act="post-alle">'
            + (postAlle ? 'Neueste ausblenden' : 'Neueste Mails trotzdem zeigen') + '</button></div>';
          if (postAlle) {
            html += postInfo.rest.map(function (m) {
              const von = m.von.replace(/<.*>/, '').replace(/"/g, '').trim() || m.von;
              return '<div class="faellig postzeile">'
                + '<div class="fgrow klickbar" data-act="post-oeffnen" data-id="' + m.id + '">'
                + '<div class="fwas">' + esc(m.betreff) + '</div>'
                + '<div class="fobj">' + esc(von) + '</div></div>'
                + '<div class="postknopf"><button class="tiny ghost" data-act="post-weg" data-id="' + m.id
                + '" title="Uninteressant — taucht nie wieder auf">✕</button></div></div>';
            }).join('');
          }
        }
      } else {
        html += postListe.map(function (m) {
          const von = m.von.replace(/<.*>/, '').replace(/"/g, '').trim() || m.von;
          const wann = m.wann ? new Date(m.wann) : null;
          const heute0 = new Date(); heute0.setHours(0, 0, 0, 0);
          const zeit = wann
            ? (wann >= heute0
                ? wann.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
                : wann.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }))
            : '';

          if (mobil) {
            return '<div class="postkarte">'
              + '<div class="pk-oben" data-act="post-oeffnen" data-id="' + m.id + '">'
              + '<div class="pk-betreff">' + esc(m.betreff) + '</div>'
              + '<div class="pk-zeit num">' + zeit + '</div></div>'
              + '<div class="pk-von">' + esc(von) + '</div>'
              + (m.objekt ? '<div class="pk-tag"><span class="mtag">'
                  + esc(m.einheit ? m.objekt.split(',')[0] + ' · ' + m.einheit : m.objekt.split(',')[0])
                  + '</span></div>' : '')
              + '<div class="pk-knoepfe">'
              + '<button class="tiny" data-act="post-aufgabe" data-id="' + m.id + '">Aufgabe</button>'
              + '<button class="tiny" data-act="post-interessent" data-id="' + m.id + '">Interessent</button>'
              + '<button class="tiny" data-act="post-belege" data-id="' + m.id + '">Beleg</button>'
              + '<button class="tiny ghost" data-act="post-oeffnen" data-id="' + m.id + '">Öffnen</button>'
              + '<button class="tiny ghost" data-act="post-weg" data-id="' + m.id + '">Uninteressant</button>'
              + '</div></div>';
          }

          return '<div class="faellig postzeile">'
            + '<div class="fgrow klickbar" data-act="post-oeffnen" data-id="' + m.id + '">'
            + '<div class="fwas">' + esc(m.betreff) + '</div>'
            + '<div class="fobj">' + esc(von)
            + (m.objekt ? ' · <span class="mtag">' + esc(m.einheit ? m.objekt.split(',')[0] + ' · ' + m.einheit : m.objekt.split(',')[0]) + '</span>' : '')
            + (zeit ? ' · ' + zeit : '')
            + '</div></div>'
            + '<div class="postknopf">'
            + '<button class="tiny ghost" data-act="post-aufgabe" data-id="' + m.id + '">Aufgabe</button>'
            + '<button class="tiny ghost" data-act="post-interessent" data-id="' + m.id + '">Interessent</button>'
            + '<button class="tiny ghost" data-act="post-belege" data-id="' + m.id + '">Beleg</button>'
            + '<button class="tiny ghost" data-act="post-weg" data-id="' + m.id + '" title="Uninteressant — taucht nie wieder auf">✕</button>'
            + '</div></div>';
        }).join('');
      }
      if (postInfo) {
        html += '<div class="poststand">'
          + (postInfo.postfach ? '<strong>' + esc(postInfo.postfach) + '</strong>'
              + (postInfo.gesamt ? ' · ' + postInfo.gesamt + ' Mails im Konto' : '') + ' · ' : '')
          + (postInfo.geprueft !== undefined ? postInfo.geprueft + ' Mails geprüft' : '')
          + (postInfo.neueste ? ' · neueste vom ' + new Date(postInfo.neueste).toLocaleString('de-DE') : '')
          + (postInfo.geholt ? ' · Stand ' + new Date(postInfo.geholt).toLocaleTimeString('de-DE') : '')
          + (postInfo.ausCache ? ' (zwischengespeichert)' : '')
          + '</div>';
      }

      if (postInfo && postInfo.versteckt && postInfo.versteckt.length) {
        html += '<div class="iabsagen"><button class="tiny ghost" data-act="post-versteckt">'
          + postInfo.versteckt.length + ' ausgeblendet — ' + (verstecktOffen ? 'verbergen' : 'anzeigen') + '</button>'
          + (verstecktOffen ? postInfo.versteckt.slice().reverse().map(function (v) {
              const von = String(v.von || '').replace(/<.*>/, '').replace(/"/g, '').trim();
              return '<div class="faellig">'
                + '<div class="fpunkt" style="background:var(--frei)"></div>'
                + '<div class="fgrow"><div class="fwas">' + esc(v.betreff || 'Ohne Betreff') + '</div>'
                + '<div class="fobj">' + esc(von) + '</div></div>'
                + '<button class="tiny ghost" data-act="post-zurueck" data-id="' + v.id + '">einblenden</button></div>';
            }).join('') : '')
          + '</div>';
      }
      html += '</div>';
    }

    return html;
  }

  function breakdown(o) {
    const r = o.units.filter(function (x) { return x.status === 'vermietet'; });
    const sum = function (fn) { return r.reduce(function (s, x) { return s + fn(x); }, 0); };
    const kalt = sum(function (x) { return n(x.rent); });
    const kueche = sum(function (x) { return n(x.kitchen); });
    const park = sum(function (x) { return n(x.parking); });
    const nk = sum(function (x) { return n(x.nk); });
    const area = sum(function (x) { return n(x.area); });
    const nt = kalt + kueche + park;
    const dep = o.units.reduce(function (s, x) { return s + (x.status === 'vermietet' ? kaution(x) : 0); }, 0);

    return '<div class="breakdown"><h3>Auswertung ' + esc(o.name) + ' · ' + r.length + ' vermietete Einheiten</h3>'
      + row('Kaltmiete', money(kalt))
      + row('Küche / Möblierung', money(kueche))
      + row('Stellplätze und Garagen', money(park))
      + '<div class="brow total"><span>Nettomiete monatlich</span><span class="num">' + money(nt) + '</span></div>'
      + row('Nebenkosten gesamt', money(nk), 'sub')
      + row('Gesamt inkl. Nebenkosten', money(nt + nk), 'sub')
      + '<div class="brow sub" style="margin-top:6px"><span>Nettomiete jährlich</span><span class="num">' + money(nt * 12) + '</span></div>'
      + (area ? row('Fläche vermietet', area.toFixed(1).replace('.', ',') + ' m²', 'sub') : '')
      + (area ? '<div class="brow schnitt"><span>Durchschnittsmiete</span><span class="num">'
          + (kalt / area).toFixed(2).replace('.', ',') + ' €/m² kalt</span></div>' : '')
      + (area && nt ? row('inklusive Küche und Stellplatz',
          (nt / area).toFixed(2).replace('.', ',') + ' €/m²', 'sub') : '')
      + (dep ? row('Kautionen (2 Kaltmieten)', money(dep), 'sub') : '')
      + '</div>'
      + mietniveau(o);
  }
  function mietniveau(o) {
    const b = n(o.benchmark);
    const wohnungen = o.units.filter(function (x) {
      return parkTypes.indexOf(x.type) === -1 && x.status === 'vermietet' && n(x.rent) && n(x.area);
    });

    let html = '<div class="breakdown"><h3>Mietniveau</h3>';

    if (o.mietspiegel || o.mietspiegelUrl) {
      let ablauf = '';
      if (o.mietspiegelBis) {
        const bis = new Date(o.mietspiegelBis);
        const tage = Math.round((bis - new Date()) / 86400000);
        ablauf = tage < 0
          ? '<span class="mswarn">abgelaufen seit ' + bis.toLocaleDateString('de-DE') + ' — neuen Wert holen</span>'
          : tage < 120
            ? '<span class="mswarn">läuft am ' + bis.toLocaleDateString('de-DE') + ' ab</span>'
            : 'gültig bis ' + bis.toLocaleDateString('de-DE');
      }
      html += '<div class="msbox">' + esc(o.mietspiegel || 'Mietspiegel')
        + (o.mietspiegelUrl ? ' · <a href="' + esc(o.mietspiegelUrl) + '" target="_blank" rel="noopener">öffnen</a>' : '')
        + (ablauf ? '<br>' + ablauf : '') + '</div>';
    }

    if (!b) {
      html += '<div class="unit-type" style="padding:2px 0 6px">Trag die ortsübliche Vergleichsmiete ein, '
        + 'dann rechnet die App Potenzial und Termine aus. Sie steht im Mietspiegel deiner Gemeinde.</div>'
        + '<button class="tiny" data-act="edit-object" data-id="' + o.id + '">Vergleichsmiete eintragen</button></div>';
      return html;
    }
    if (!wohnungen.length) {
      html += '<div class="unit-type">Noch keine vermietete Wohnung mit Fläche und Miete erfasst.</div></div>';
      return html;
    }

    const flaeche = wohnungen.reduce(function (a, x) { return a + n(x.area); }, 0);
    const kalt = wohnungen.reduce(function (a, x) { return a + n(x.rent); }, 0);
    const istQm = kalt / flaeche;
    const diff = (istQm / b - 1) * 100;
    const rows = wohnungen.map(function (x) { return { x: x, e: erhoehung(x, b) }; });
    const potenzial = rows.reduce(function (a, r) { return a + r.e.potenzial; }, 0);
    const jetzt = rows.filter(function (r) { return r.e.moeglich; });
    const spaeter = rows.filter(function (r) { return !r.e.moeglich && r.e.potenzial >= 1 && r.e.ab; })
      .sort(function (a, c) { return a.e.ab - c.e.ab; });

    html += row('Ortsübliche Vergleichsmiete', b.toFixed(2).replace('.', ',') + ' €/m²')
      + row('Deine Kaltmiete im Schnitt', istQm.toFixed(2).replace('.', ',') + ' €/m²')
      + row('Abweichung', (diff >= 0 ? '+' : '') + diff.toFixed(1).replace('.', ',') + ' %',
            diff < -5 ? 'warn' : 'sub')
      + '<div class="brow total"><span>Erhöhungspotenzial monatlich</span><span class="num">'
      + (potenzial >= 1 ? money(potenzial) : '—') + '</span></div>';

    if (jetzt.length) {
      html += '<div class="niveau-block"><strong>Jetzt möglich</strong>'
        + jetzt.map(function (r) {
            return '<div class="brow"><span>' + esc(r.x.name) + ' · auf ' + money(r.e.ziel)
              + (r.e.grund ? ' (' + r.e.grund + ')' : '') + '</span><span class="num">+ '
              + money(r.e.potenzial) + '</span></div>';
          }).join('') + '</div>';
    }
    if (spaeter.length) {
      html += '<div class="niveau-block"><strong>Frühestens später</strong>'
        + spaeter.map(function (r) {
            return '<div class="brow"><span>' + esc(r.x.name) + ' · ab '
              + r.e.ab.toLocaleDateString('de-DE') + '</span><span class="num">+ '
              + money(r.e.potenzial) + '</span></div>';
          }).join('') + '</div>';
    }
    if (!jetzt.length && !spaeter.length) {
      html += '<div class="unit-type">Alle Wohnungen liegen auf oder über dem Vergleichsniveau.</div>';
    }

    html += '<div class="legal">Faustregeln: Die Miete muss 15 Monate unverändert sein, bevor eine Erhöhung '
      + 'wirksam wird, und darf in drei Jahren höchstens um 20 % steigen — in angespannten Wohnlagen um 15 %. '
      + 'Ohne Einzugs- oder Erhöhungsdatum kann die App den Termin nicht berechnen. Das ist keine Rechtsberatung.</div>';
    return html + '</div>';
  }

  function row(l, v, cls) {
    return '<div class="brow ' + (cls || '') + '"><span>' + l + '</span><span class="num">' + v + '</span></div>';
  }

  function renderEinrichten() {
    root.setAttribute('data-theme', theme);
    root.innerHTML = '<div class="sperrschirm"><div class="sperrkasten">'
      + '<h1>Zugang einrichten</h1>'
      + '<div class="hint">Leg deinen eigenen Zugang an. Weitere Personen kannst du später '
      + 'hinzufügen — sie sehen dann dieselben Daten.</div>'
      + '<div class="field"><label>Benutzername</label><input type="text" id="e-name"></div>'
      + '<div class="field"><label>Passwort</label><input type="password" id="e-pw1"></div>'
      + '<div class="field"><label>Wiederholen</label><input type="password" id="e-pw2"></div>'
      + '<button class="primary" data-act="ein">Loslegen</button>'
      + '<div class="legal">Mindestens acht Zeichen. Passwörter werden nirgends gespeichert — '
      + 'ohne sie kommt niemand mehr an die Daten, auch ich nicht.</div>'
      + '</div></div>';
    const los = function () {
      const name = root.querySelector('#e-name').value.trim();
      const a = root.querySelector('#e-pw1').value.trim();
      const b = root.querySelector('#e-pw2').value.trim();
      if (!name) { toast('Benutzername fehlt'); return; }
      if (a.length < 8) { toast('Mindestens acht Zeichen'); return; }
      if (a !== b) { toast('Die beiden Eingaben stimmen nicht überein'); return; }
      zugangEinrichten(name, a);
    };
    root.querySelector('[data-act="ein"]').addEventListener('click', los);
    ['#e-name', '#e-pw1', '#e-pw2'].forEach(function (id) {
      root.querySelector(id).addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); los(); }
      });
    });
    if (!mobil) root.querySelector('#e-name').focus();
  }

  function renderAnmelden() {
    root.setAttribute('data-theme', theme);
    root.innerHTML = '<div class="sperrschirm"><div class="sperrkasten">'
      + '<h1>Anmelden</h1>'
      + '<div class="hint">Diese Verwaltung ist verschlüsselt. Benutzername und Passwort bekommst '
      + 'du vom Eigentümer.</div>'
      + '<div class="field"><label>Benutzername</label><input type="text" id="a-name"></div>'
      + '<div class="field"><label>Passwort</label><input type="password" id="a-pw"></div>'
      + '<button class="primary" data-act="an">Öffnen</button>'
      + '</div></div>';
    const rein = function () {
      anmelden(root.querySelector('#a-name').value, root.querySelector('#a-pw').value);
    };
    root.querySelector('[data-act="an"]').addEventListener('click', rein);
    ['#a-name', '#a-pw'].forEach(function (id) {
      root.querySelector(id).addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); rein(); }
      });
    });
    if (!mobil) root.querySelector('#a-name').focus();
  }

  function fensterZu() {
    tdMenue = null;
    if (tdEditor && (tdEditor.ort === 'schnell' || tdEditor.ort.indexOf('unter:') === 0)) tdEditor = null;
    const bd = root.querySelector('.backdrop');
    if (bd && mobil) {
      bd.classList.add('zu');
      setTimeout(function () { modal = null; render(); }, 190);
    } else { modal = null; render(); }
  }

  let scrollMerker = 0;
  function scrollSperre(an) {
    const b = document.body;
    if (an && b.style.position !== 'fixed') {
      scrollMerker = window.scrollY;
      b.style.top = -scrollMerker + 'px';
      b.style.position = 'fixed';
      b.style.width = '100%';
    } else if (!an && b.style.position === 'fixed') {
      b.style.position = '';
      b.style.top = '';
      b.style.width = '';
      window.scrollTo(0, scrollMerker);
    }
  }

  function kpi(l, v, hero, fuss) {
    return '<div class="kpi' + (hero ? ' hero' : '') + '">'
      + '<div class="label">' + l + '</div>'
      + '<div class="value num">' + v + '</div>'
      + (fuss ? '<div class="kpizeile">' + fuss + '</div>' : '')
      + '</div>';
  }

  // ---- Suche für alles (Lupe oben, Strg+K) ----
  function sucheTreffer(q) {
    const worte = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!worte.length) return [];
    const passt = function () {
      const text = Array.prototype.slice.call(arguments).join(' ').toLowerCase();
      return worte.every(function (w) { return text.indexOf(w) !== -1; });
    };
    const gruppen = [];
    const gruppe = function (name, liste) { if (liste.length) gruppen.push({ name: name, liste: liste.slice(0, 5), mehr: liste.length - 5 }); };

    gruppe('Objekte', data.objects.filter(function (o) { return passt(o.name, o.note); }).map(function (o) {
      return { typ: 'objekt', id: o.id, titel: o.name, unten: o.units.length + ' Einheiten' };
    }));
    const einheiten = [];
    data.objects.forEach(function (o) {
      o.units.forEach(function (x) {
        if (passt(o.name, x.name, x.tenant, x.contact, x.type)) {
          einheiten.push({ typ: 'einheit', oid: o.id, id: x.id, titel: (x.tenant || x.name || 'Einheit'),
            unten: o.name + (x.tenant ? ' · ' + x.name : '') });
        }
      });
    });
    gruppe('Einheiten und Mieter', einheiten);
    gruppe('Interessenten', (data.interessenten || []).filter(function (i) { return passt(i.name, i.kontakt, i.notiz); })
      .map(function (i) { return { typ: 'interessent', id: i.id, titel: i.name || 'Interessent', unten: i.kontakt || einheitKurz(i.einheitId) || '' }; }));
    gruppe('Aufgaben', (alleAufgaben || []).filter(function (t) { return passt(t.inhalt, t.beschreibung); })
      .map(function (t) { return { typ: 'aufgabe', id: t.id, titel: t.inhalt, unten: (t.faellig ? rgDatum(t.faellig) + ' · ' : '') + (tdProjektName(t.projektId) || '') }; }));
    gruppe('Post', (postListe || []).concat((postInfo && postInfo.rest) || []).filter(function (m) { return passt(m.betreff, m.von); })
      .map(function (m) { return { typ: 'post', id: m.id, titel: m.betreff, unten: String(m.von || '').replace(/<.*>/, '').replace(/"/g, '').trim() }; }));
    gruppe('Abrechnungen', ((rg && rg.liste) || []).filter(function (e) { return passt(e.nummer, e.objekt); })
      .map(function (e) { return { typ: 'rechnung', id: e.id, titel: e.nummer, unten: e.objekt || '' }; }));
    return gruppen;
  }

  function sucheTrefferHtml(q) {
    if (!String(q || '').trim()) return '<div class="such-leer">Objekte, Mieter, Interessenten, Aufgaben, Mails und Abrechnungen</div>';
    const gruppen = sucheTreffer(q);
    if (!gruppen.length) return '<div class="such-leer">Nichts gefunden</div>';
    let erster = true;
    return gruppen.map(function (g) {
      return '<div class="such-gruppe"><div class="such-kopf">' + g.name + '</div>'
        + g.liste.map(function (t) {
          const html = '<button class="such-treffer' + (erster ? ' gewaehlt' : '') + '" data-act="such-treffer" data-typ="' + t.typ
            + '" data-id="' + esc(String(t.id)) + '"' + (t.oid ? ' data-oid="' + t.oid + '"' : '') + '>'
            + '<span class="st-titel">' + esc(t.titel) + '</span>'
            + (t.unten ? '<span class="st-unten">' + esc(t.unten) + '</span>' : '') + '</button>';
          erster = false;
          return html;
        }).join('')
        + (g.mehr > 0 ? '<div class="such-mehr">und ' + g.mehr + ' weitere – genauer suchen</div>' : '')
        + '</div>';
    }).join('');
  }

  function sucheOeffnen() {
    if (phase !== 'app' || !data) return;
    tdMenue = null;
    modal = { kind: 'suche', q: '' };
    render();
    fensterGeoeffnet();
  }

  function sucheBinden() {
    const feld = root.querySelector('#suche-q');
    if (!feld) return;
    const ziel = root.querySelector('#suche-treffer');
    feld.focus();
    feld.addEventListener('input', function () {
      modal.q = feld.value;
      ziel.innerHTML = sucheTrefferHtml(feld.value);
      ziel.querySelectorAll('[data-act]').forEach(function (el) {
        el.addEventListener('click', function (ev) { ev.stopPropagation(); handle('such-treffer', el); });
      });
    });
    feld.addEventListener('keydown', function (ev) {
      const alle = Array.prototype.slice.call(ziel.querySelectorAll('.such-treffer'));
      if (!alle.length) return;
      let i = alle.findIndex(function (b) { return b.classList.contains('gewaehlt'); });
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (i >= 0) alle[i].classList.remove('gewaehlt');
        i = ev.key === 'ArrowDown' ? Math.min(alle.length - 1, i + 1) : Math.max(0, i - 1);
        alle[i].classList.add('gewaehlt');
        alle[i].scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 'Enter') {
        ev.preventDefault(); ev.stopPropagation();
        handle('such-treffer', alle[Math.max(0, i)]);
      }
    });
  }

  function sucheSpringen(el) {
    const typ = el.getAttribute('data-typ'), id = el.getAttribute('data-id');
    modal = null;
    if (typ === 'objekt') {
      ansicht = 'objekte'; query = ''; open[id] = true; render();
      const kopf = root.querySelector('.obj-head[data-id="' + id + '"]');
      if (kopf) kopf.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (typ === 'einheit') {
      openUnit(el.getAttribute('data-oid'), id);
    } else if (typ === 'interessent') {
      const inter = interessentVon(id);
      if (inter) modal = { kind: 'interessent', isNew: false, i: inter };
      render();
    } else if (typ === 'aufgabe') {
      render(); tdOeffnen(id);
    } else if (typ === 'post') {
      const m = (postListe || []).concat((postInfo && postInfo.rest) || []).find(function (z) { return z.id === id; });
      render();
      if (m) window.open(m.url, '_blank', 'noopener');
    } else if (typ === 'rechnung') {
      const e = rg && rg.liste.find(function (x) { return String(x.id) === String(id); });
      ansicht = 'rechnungen';
      if (e) rgTab = e.art || 'as';
      rgAusListe(id);
      render();
    } else render();
  }

  function renderModal() {
    let body = '';
    if (modal.kind === 'absender') {
      body = absenderFenster();
    } else if (modal.kind === 'suche') {
      body = '<div class="such-feld"><input type="search" id="suche-q" placeholder="Suchen …" autocomplete="off" value="' + esc(modal.q || '') + '"></div>'
        + '<div id="suche-treffer">' + sucheTrefferHtml(modal.q) + '</div>';
    } else if (modal.kind === 'unit') {
      const x = modal.unit;
      body = '<h2>' + (modal.isNew ? 'Einheit hinzufügen' : esc(x.name || 'Einheit')) + '</h2>'
        + '<div class="hint">Nettomiete = Kalt + Küche + Stellplatz · Kaution leer lassen = 2 Monatskaltmieten<br>'
        + 'Enter speichert, Esc bricht ab</div>'
        + f('Bezeichnung', '<input type="text" id="m-name" value="' + esc(x.name) + '" placeholder="z. B. 2.OG Links">')
        + '<div class="two">'
        + f('Art', sel('m-type', ['Wohnung', 'Gewerbe', 'Stellplatz', 'Garage', 'Sonstiges'], x.type))
        + f('Status', sel('m-status', [['vermietet', 'Vermietet'], ['frei', 'Frei'], ['gesperrt', 'Nicht vermietbar'], ['unbekannt', 'Offen']], x.status))
        + '</div><div class="divider"></div>'
        + (!x.tenant && x.hint ? '<div class="hintbox">Aus den Unterlagen: ' + esc(x.hint)
            + '<br>Verschwindet, sobald ein Mieter eingetragen ist.</div>' : '')
        + f('Mieter', '<input type="text" id="m-tenant" value="' + esc(x.tenant) + '" placeholder="Name">')
        + f('Kontakt', '<input type="text" id="m-contact" value="' + esc(x.contact || '') + '" placeholder="Telefon oder E-Mail">')
        + '<div class="two">'
        + f('Einzug', '<input type="date" id="m-movein" value="' + esc(x.movein || '') + '">')
        + f('Letzte Mieterhöhung', '<input type="date" id="m-inc" value="' + esc(x.lastIncrease || '') + '">')
        + '</div><div class="divider"></div>'
        + '<div class="two">'
        + f('Fläche (m²)', '<input type="number" id="m-area" step="0.1" value="' + (x.area == null ? '' : x.area) + '">')
        + f('Kaution', '<input type="number" id="m-deposit" step="0.01" value="' + (x.deposit == null ? '' : x.deposit)
            + '" placeholder="' + (n(x.rent) ? (n(x.rent) * 2).toFixed(2) : '2 x Kaltmiete') + '">')
        + '</div><div class="two">'
        + f('Kaltmiete', '<input type="number" id="m-rent" step="0.01" value="' + (x.rent == null ? '' : x.rent) + '">')
        + f('Küche / Möblierung', '<input type="number" id="m-kitchen" step="0.01" value="' + (x.kitchen == null ? '' : x.kitchen) + '">')
        + '</div><div class="two">'
        + f('Stellplatz / Garage', '<input type="number" id="m-parking" step="0.01" value="' + (x.parking == null ? '' : x.parking) + '">')
        + f('Nebenkosten', '<input type="number" id="m-nk" step="0.01" value="' + (x.nk == null ? '' : x.nk) + '">')
        + '</div>'
        + '<div class="sum-line"><span>Nettomiete</span><span class="num">' + money(netto(x)) + '</span></div>'
        + '<div class="sum-line plain"><span>Gesamt inkl. Nebenkosten</span><span class="num">' + money(brutto(x)) + '</span></div>'
        + '<div class="sum-line plain"><span>Kaution' + (x.deposit == null ? ' (2 Kaltmieten)' : ' (abweichend)') + '</span><span class="num">' + money(kaution(x)) + '</span></div>'
        + '<div class="divider"></div>'
        + '<div class="field"><label>Dokumente</label><div class="doclist">'
        + (x.docs && x.docs.length ? x.docs.map(function (d, i) {
            return '<div class="docrow"><div class="grow"><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.name) + '</a></div>'
              + '<button class="tiny ghost" data-act="del-doc" data-i="' + i + '">Entfernen</button></div>';
          }).join('') : '<div class="docempty">Noch keine Dokumente verknüpft.</div>')
        + '</div></div>'
        + '<div class="two">'
        + f('Neues Dokument', '<input type="text" id="m-docname" placeholder="z. B. Mietvertrag">')
        + f('Link (Drive)', '<input type="url" id="m-docurl" placeholder="https://drive.google.com/…">')
        + '</div>'
        + '<button class="tiny" data-act="add-doc">Dokument verknüpfen</button>'
        + '<div class="divider"></div>'
        + f('Notiz', '<textarea id="m-note" rows="2" placeholder="Zählernummer, Kündigungsfrist, offene Punkte">' + esc(x.note) + '</textarea>')
        + '<div class="modal-actions">'
        + (modal.isNew ? '' : '<button data-act="schreiben" data-oid="' + modal.oid + '" data-uid="' + modal.unit.id + '">Schreiben</button>')
        + (modal.isNew ? '' : '<button class="danger" data-act="delete-unit">Löschen</button>')
        + '<div class="spacer"></div><button data-act="close">Abbrechen</button>'
        + '<button class="primary" data-act="save-unit">Speichern</button></div>';
    } else if (modal.kind === 'interessent') {
      const inter = modal.i;
      const auswahl = [['', '— noch offen —']].concat(
        allUnits().filter(function (t) { return t.u.status === 'frei' || t.u.id === inter.einheitId; })
          .map(function (t) { return [t.u.id, t.o.name.split(',')[0] + ' · ' + t.u.name]; })
      );
      body = '<h2>' + (modal.isNew ? 'Interessent vormerken' : esc(inter.name || 'Interessent')) + '</h2>'
        + '<div class="hint">'
        + (inter.quelle ? esc(inter.quelle) + '<br>' : '')
        + (modal.isNew ? 'Enter speichert, Esc bricht ab — die Wohnungsliste zeigt alles, was frei ist'
            : 'Vorgemerkt am ' + dateDE(inter.angelegt))
        + '</div>'
        + f('Name', '<input type="text" id="i-name" value="' + esc(inter.name) + '" placeholder="Vor- und Nachname">')
        + f('Kontakt', '<input type="text" id="i-kontakt" value="' + esc(inter.kontakt) + '" placeholder="Telefon oder E-Mail">')
        + '<div class="two">'
        + f('Wohnung', sel('i-einheit', auswahl, inter.einheitId))
        + f('Stand', sel('i-status', ISTATUS, inter.status))
        + '</div>'
        + f('Besichtigung', '<input type="datetime-local" id="i-termin" value="' + esc(inter.termin) + '">')
        + f('Notiz', '<textarea id="i-notiz" rows="3" placeholder="Eindruck, Unterlagen, Rückfragen">' + esc(inter.notiz) + '</textarea>')
        + '<div class="modal-actions">'
        + (modal.isNew ? '' : '<button class="danger" data-act="interessent-loeschen">Löschen</button>')
        + (todoist.verbunden ? '<button data-act="interessent-termin-aufgabe">Termin nach Todoist</button>' : '')
        + '<div class="spacer"></div><button data-act="close">Abbrechen</button>'
        + '<button class="primary" data-act="interessent-speichern">Speichern</button></div>';

    } else if (modal.kind === 'push') {
      const kann = pushKann();
      const aktiv = !!pushAbo;
      body = '<h2>Mitteilungen</h2>'
        + '<div class="hint">Der Server meldet sich von selbst — morgens mit dem Tagesüberblick aus Aufgaben, Besichtigungen, Rückständen und Fristen.</div>'
        + (pushFehler ? '<div class="hintbox">' + esc(pushFehler) + '</div>' : '')
        + (!kann ? '<div class="hintbox">Dieser Browser unterstützt keine Web-Mitteilungen.</div>' : '')
        + (kann && pushIosHinweis() ? '<div class="hintbox">Am iPhone zuerst installieren: Teilen-Symbol → „Zum Home-Bildschirm". Danach die installierte App öffnen und hier aktivieren — Safari selbst darf keine Mitteilungen.</div>' : '')
        + '<div class="sum-line plain"><span>Dieses Gerät</span><span>' + (aktiv ? 'Mitteilungen aktiv' : 'aus') + '</span></div>'
        + '<div class="modal-actions" style="justify-content:flex-start;margin:10px 0 2px">'
        + (aktiv
            ? '<button data-act="push-aus">Ausschalten</button><button data-act="push-test">Probemitteilung</button>'
            : '<button class="primary" data-act="push-an"' + (kann ? '' : ' disabled') + '>Auf diesem Gerät aktivieren</button>')
        + '</div>'
        + '<div class="divider"></div>'
        + '<div class="two">'
        + f('Morgenmeldung', sel('p-morgen', [['an', 'Eingeschaltet'], ['aus', 'Ausgeschaltet']], (pushEinst && pushEinst.morgen === false) ? 'aus' : 'an'))
        + f('Uhrzeit', '<input type="time" id="p-zeit" value="' + esc((pushEinst && pushEinst.zeit) || '07:00') + '">')
        + '</div><div class="two">'
        + f('Vor Besichtigungen', sel('p-termine', [['an', 'Eingeschaltet'], ['aus', 'Ausgeschaltet']], (pushEinst && pushEinst.termine === false) ? 'aus' : 'an'))
        + f('Neue Anfragen', sel('p-anfragen', [['an', 'Eingeschaltet'], ['aus', 'Ausgeschaltet']], (pushEinst && pushEinst.anfragen === false) ? 'aus' : 'an'))
        + '</div><div class="two">'
        + f('„Jetzt dran“ zu jedem Block', sel('p-bloecke', [['an', 'Eingeschaltet'], ['aus', 'Ausgeschaltet']], (pushEinst && pushEinst.bloecke === false) ? 'aus' : 'an'))
        + f('Abends: Liegengebliebenes', '<div style="display:flex;gap:8px">'
            + sel('p-abends', [['an', 'An'], ['aus', 'Aus']], (pushEinst && pushEinst.abends === false) ? 'aus' : 'an')
            + '<input type="time" id="p-abendzeit" value="' + esc((pushEinst && pushEinst.abendZeit) || '18:00') + '"></div>')
        + '</div>'
        + (google.verbunden ? '' : '<div class="unit-type" style="margin:-2px 0 10px">Die Anfragen-Meldung braucht das verbundene Postfach.</div>')
        + '<button class="tiny" data-act="push-zeit">Übernehmen</button>'
        + '<div class="divider"></div>'
        + '<div class="field"><label>Angemeldete Geräte</label><div class="doclist">'
        + (pushGeraete === null
            ? '<div class="docempty">wird geladen …</div>'
            : (!pushGeraete.length
                ? '<div class="docempty">Noch kein Gerät angemeldet.</div>'
                : pushGeraete.map(function (g) {
                    return '<div class="docrow"><div class="grow">' + esc(g.geraet || 'Gerät') + ' · ' + esc(g.nutzer || '')
                      + (aktiv && pushAbo.endpoint === g.endpoint ? ' <span class="mtag">dieses Gerät</span>' : '')
                      + '</div>'
                      + '<button class="tiny ghost" data-act="push-geraet-weg" data-id="' + g.id + '">Entfernen</button></div>';
                  }).join('')))
        + '</div></div>'
        + '<div class="modal-actions"><div class="spacer"></div><button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'menue') {
      body = '<h2>Menü</h2>'
        + '<div class="menueliste">'
        + '<button data-act="add-object">Objekt anlegen</button>'
        + '<button data-act="interessent-neu">Interessent vormerken</button>'
        + '<button data-act="datei-sichern">Sichern als Datei</button>'
        + '<button data-act="datei-laden">Aus Datei laden</button>'
        + '<button data-act="export">Als Tabelle kopieren</button>'
        + '<button data-act="staende">Verlauf</button>'
        + (nutzerRolle === 'verwalter' ? '<button data-act="zugaenge">Zugänge</button>' : '')
        + '<button data-act="todoist">Todoist</button>'
        + '<button data-act="google">Postfach</button>'
        + '<button data-act="gkal">Kalender</button>'
        + '<button data-act="push">Mitteilungen</button>'
        + '<button data-act="stimme">Vorlesestimme</button>'
        + '<button data-act="assistent">Assistent</button>'
        + '<button data-act="abmelden">Abmelden</button>'
        + '</div>'
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'aufgabe') {
      const t = tdFinde(modal.aufgabe.id) || modal.aufgabe;
      modal.aufgabe = t;
      const e = modal.entwurf || {};
      const inhalt = e.inhalt !== undefined ? e.inhalt : t.inhalt;
      const besch = e.beschreibung !== undefined ? e.beschreibung : (t.beschreibung || '');
      const faellig = e.faellig !== undefined ? e.faellig : (t.faellig || '');
      const prio = e.prioritaet || t.prioritaet || 1;
      const projektId = e.projektId || t.projektId;
      const kinder = tdKinder(t.id);
      const heute0 = tdHeute();
      const schnell = function (name, d, farbe, zeichen) {
        return '<button type="button" class="' + farbe + '" data-act="t-datum" data-datum="' + (d ? tdIso(d) : '') + '">' + zeichen + name + '</button>';
      };

      body = '<h2>Aufgabe</h2>'
        + '<div class="td-fenster">'
        + '<div class="td-f-links">'
        + '<div class="td-f-titel td-zeile p' + prio + '" id="t-kopf">'
        + '<button type="button" class="td-kreis" data-act="t-fertig" title="Abhaken">' + TDI.check + '</button>'
        + '<input type="text" id="t-inhalt" value="' + esc(inhalt) + '" placeholder="Aufgabenname"></div>'
        + '<div class="td-f-besch"><textarea id="t-besch" rows="' + Math.max(3, Math.min(14, String(besch).split('\n').length + 1)) + '" placeholder="Beschreibung">' + esc(besch) + '</textarea></div>'
        + '<div class="td-verlauf"><input type="text" id="t-verlauf" placeholder="+ Verlauf, z. B. „Aldo angerufen, kommt Dienstag“" value="' + esc(modal.verlaufText || '') + '">'
        + ((window.SpeechRecognition || window.webkitSpeechRecognition) ? '<button type="button" class="tiny" data-act="t-verlauf-diktat" title="Diktieren">🎤</button>' : '')
        + '<button type="button" class="tiny primary" data-act="t-verlauf">Eintragen</button></div>'
        + '<div class="td-f-ueber">Unteraufgaben' + (kinder.length ? '<span class="td-zahl">' + kinder.length + '</span>' : '') + '</div>'
        + kinder.map(function (k) { return tdZeile(k, { mitProjekt: false }); }).join('')
        + tdNeuHtml('unter:' + t.id, { eltern: t.id, projektId: t.projektId, text: 'Unteraufgabe hinzufügen' })
        + '<div class="td-f-ueber">Kommentare' + (modal.kommentare && modal.kommentare.length ? '<span class="td-zahl">' + modal.kommentare.length + '</span>' : '') + '</div>'
        + (!modal.kommentare
            ? '<div class="docempty">werden geladen …</div>'
            : (modal.kommentare.length
                ? modal.kommentare.map(function (k) {
                    return '<div class="td-kommentar">' + esc(k.inhalt)
                      + (k.datei ? ' <a href="' + esc(k.datei) + '" target="_blank" rel="noopener">Datei</a>' : '')
                      + '<div class="td-f-klein">' + (k.wann ? new Date(k.wann).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '') + '</div></div>';
                  }).join('')
                : '<div class="docempty">Noch keine Kommentare.</div>'))
        + '<div class="aufgabe-neu" style="margin-top:10px">'
        + '<input type="text" id="t-kommentar" placeholder="Kommentar schreiben">'
        + '<button type="button" class="tiny" data-act="t-kommentar">Senden</button></div>'
        + '</div>'
        + '<div class="td-f-rechts">'
        + '<div class="td-f-feld"><label>Projekt</label><select id="t-projekt">' + tdProjektListe().map(function (p) {
            return '<option value="' + esc(p.id) + '"' + (p.id === projektId ? ' selected' : '') + '>' + esc(p.eingang ? 'Eingang' : p.name) + '</option>';
          }).join('') + '</select></div>'
        + '<div class="td-f-feld"><label>Fällig</label><input type="date" id="t-faellig" value="' + esc(faellig) + '">'
        + '<div class="td-f-schnell">'
        + schnell('Heute', heute0, 'gruen', tdHeuteZeichen(heute0.getDate()))
        + schnell('Morgen', tdPlus(1), 'orange', TDI.sonne)
        + schnell('Nächste Woche', tdNaechsteWoche(), 'lila', TDI.weiter)
        + schnell('Kein Datum', null, '', TDI.kreisX)
        + '</div>'
        + (t.faelligText ? '<div class="td-f-klein">' + (t.wiederkehrend ? 'Wiederholt sich: ' : 'In Todoist: ') + esc(t.faelligText) + '</div>' : '')
        + '</div>'
        + '<div class="td-f-feld"><label>Priorität</label>' + tdFlaggen(prio, 't-prio', t.id)
        + '<input type="hidden" id="t-prio" value="' + prio + '"></div>'
        + ((t.labels || []).length
            ? '<div class="td-f-feld"><label>Labels</label><div class="td-f-labels">'
              + t.labels.map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('') + '</div></div>'
            : '')
        + (t.angelegt ? '<div class="td-f-klein">Angelegt am ' + new Date(t.angelegt).toLocaleDateString('de-DE') + '</div>' : '')
        + '</div></div>'
        + '<div class="modal-actions">'
        + '<button type="button" class="danger" data-act="t-loeschen">Löschen</button>'
        + '<a href="' + esc(t.url) + '" target="_blank" rel="noopener" class="tdlink">In Todoist öffnen</a>'
        + '<div class="spacer"></div>'
        + '<button type="button" data-act="close">Abbrechen</button>'
        + '<button type="button" class="primary" data-act="t-speichern">Speichern</button></div>';

    } else if (modal.kind === 'schnell') {
      body = '<h2>Aufgabe hinzufügen</h2>' + (tdEditor ? tdEditorHtml() : '')
        + '<div class="legal">Datum und Priorität kannst du einfach mitschreiben — „morgen Rechnung schreiben p1“ '
        + 'oder „Zähler ablesen 5.9. 15 Uhr“. Am Rechner öffnet die Taste q dieses Fenster.</div>';

    } else if (modal.kind === 'beleg') {
      const m = modal.mail;
      body = '<h2>Beleg ablegen</h2>'
        + '<div class="hint">' + esc(m.betreff) + '<br>' + esc(m.von) + '</div>'
        + (!modal.anhaenge
            ? '<div class="docempty">wird geladen …</div>'
            : (modal.anhaenge.length
                ? '<div class="doclist">' + modal.anhaenge.map(function (a, i) {
                    return '<div class="docrow"><div class="grow">' + esc(a.name)
                      + '<div class="unit-type">' + Math.round(a.groesse / 1024) + ' KB · ' + esc(a.typ) + '</div></div>'
                      + '<button class="tiny" data-act="beleg-ablegen" data-i="' + i + '">Ablegen</button></div>';
                  }).join('') + '</div>'
                : '<div class="docempty">Diese Mail hat keine Anhänge.</div>'))
        + '<div class="divider"></div>'
        + f('Zielordner', '<select id="beleg-ziel">'
            + '<option value="">Drive-Hauptordner</option>'
            + data.objects.filter(function (o) { return o.ordnerId; }).map(function (o) {
                return '<option value="' + esc(o.ordnerId) + '"'
                  + (m.objekt === o.name ? ' selected' : '') + '>' + esc(o.name.split(',')[0]) + '</option>';
              }).join('')
            + '</select>')
        + '<div class="legal">Objekte ohne hinterlegten Drive-Ordner erscheinen hier nicht. '
        + 'Die Ordner-ID steht in der Adresszeile, wenn du den Ordner in Drive öffnest — '
        + 'der Teil nach /folders/. Trag sie beim Objekt unter „Objekt bearbeiten" ein.</div>'
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'auszug') {
      const z = modal.zuordnung || [];
      const getroffen = z.filter(function (e) { return e.einheit; });

      body = '<h2>Kontoauszug einlesen</h2>'
        + '<div class="hint">Lade die CSV- oder CAMT-Datei deiner Bank hoch. Die App sucht die Mieternamen '
        + 'im Verwendungszweck und trägt die Zahlungen ins Mietkonto ein. Nur Eingänge werden berücksichtigt.</div>'
        + '<div class="aufgabe-neu">'
        + '<input type="file" id="auszug-datei" accept=".csv,.xml,.txt">'
        + '</div>';

      if (!z.length) {
        body += '<div class="docempty">Noch keine Datei eingelesen.</div>';
      } else {
        body += '<div class="sum-line"><span>' + z.length + ' Eingänge gefunden</span>'
          + '<span class="num">' + getroffen.length + ' zugeordnet</span></div>'
          + '<table><thead><tr><th>Datum</th><th class="right">Betrag</th><th>Verwendungszweck</th>'
          + '<th>Zuordnung</th></tr></thead><tbody>'
          + z.slice(0, 60).map(function (e, i) {
              return '<tr><td class="num">' + (e.buchung.datum ? e.buchung.datum.toLocaleDateString('de-DE') : '—') + '</td>'
                + '<td class="right num strong">' + money(e.buchung.betrag) + '</td>'
                + '<td class="notecell">' + esc((e.buchung.text || '').slice(0, 70)) + '</td>'
                + '<td>' + (e.einheit
                    ? '<span class="mtag stark">' + esc(e.objekt.name.split(',')[0] + ' · ' + e.einheit.name) + '</span>'
                    : '<span class="unit-type">keine</span>') + '</td></tr>';
            }).join('')
          + '</tbody></table>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="auszug-buchen">' + getroffen.length
          + ' Zahlungen ins Mietkonto übernehmen</button></div>'
          + '<div class="legal">Übernommen wird pro Mieter und Monat die Summe der Eingänge. '
          + 'Bereits erfasste Beträge werden überschrieben.</div>';
      }

      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'nk') {
      const o = findObj(modal.oid);
      const d = nkDaten(o);
      const einheiten = nkEinheiten(o);
      const summeKosten = d.posten.reduce(function (a, p) { return a + n(p.betrag); }, 0);

      body = '<h2>Betriebskostenabrechnung</h2>'
        + '<div class="hint">' + esc(o.name) + ' · Jahreskosten eintragen, die App verteilt sie auf '
        + einheiten.length + ' vermietete Wohnungen und rechnet gegen die Vorauszahlungen.</div>'
        + '<div class="two">'
        + f('Abrechnungsjahr', '<input type="number" id="nk-jahr" value="' + d.jahr + '">')
        + f('Summe der Kosten', '<input type="text" readonly value="' + money(summeKosten) + '">')
        + '</div>';

      if (!d.posten.length) {
        body += '<div class="docempty">Noch keine Kostenarten erfasst.</div>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="nk-vorlage">Übliche Kostenarten anlegen</button></div>';
      } else {
        body += (mobil
          ? d.posten.map(function (p, i) {
              return '<div class="ekarte" style="cursor:default">'
                + '<div class="feldchen"><span>Kostenart</span>'
                + '<input type="text" id="nk-n-' + i + '" value="' + esc(p.name) + '"></div>'
                + '<div class="feldpaar">'
                + '<label class="feldchen"><span>Betrag im Jahr</span>'
                + '<input type="number" step="0.01" inputmode="decimal" id="nk-b-' + i + '" value="'
                + (p.betrag == null ? '' : p.betrag) + '"></label>'
                + '<label class="feldchen"><span>Verteilung</span>'
                + sel('nk-s-' + i, [['flaeche', 'nach Fläche'], ['einheit', 'je Einheit'],
                    ['verbrauch', 'nach Verbrauch']], p.schluessel) + '</label>'
                + '</div>'
                + '<div class="ekopf" style="margin-top:8px"><span></span>'
                + '<button class="tiny ghost" data-act="nk-weg" data-i="' + i + '">Entfernen</button></div>'
                + '</div>';
            }).join('')
          : '<table><thead><tr><th>Kostenart</th><th class="right">Betrag im Jahr</th>'
            + '<th>Verteilung</th><th></th></tr></thead><tbody>'
            + d.posten.map(function (p, i) {
                return '<tr><td><input type="text" id="nk-n-' + i + '" value="' + esc(p.name) + '" style="min-width:170px"></td>'
                  + '<td><input type="number" step="0.01" id="nk-b-' + i + '" value="'
                  + (p.betrag == null ? '' : p.betrag) + '" style="min-width:100px"></td>'
                  + '<td>' + sel('nk-s-' + i, [['flaeche', 'nach Fläche'], ['einheit', 'je Einheit'],
                      ['verbrauch', 'nach Verbrauch']], p.schluessel) + '</td>'
                  + '<td><button class="tiny ghost" data-act="nk-weg" data-i="' + i + '">Weg</button></td></tr>';
              }).join('')
            + '</tbody></table>')
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="nk-rechnen">Berechnen und speichern</button>'
          + '<button data-act="nk-zeile-neu">Zeile hinzufügen</button></div>';

        if (summeKosten) {
          const ergebnisse = nkRechnung(o);
          body += '<div class="divider"></div><div class="breakdown"><h3>Ergebnis</h3><div class="pv-ergebnis">'
            + ergebnisse.map(function (r) {
                return '<div class="niveau-block"><strong>' + esc(r.unit.name) + ' · '
                  + esc(r.unit.tenant || '') + '</strong>'
                  + row('Anteil', (r.anteilFlaeche * 100).toFixed(1).replace('.', ',') + ' %', 'sub')
                  + '<div class="brow total"><span>Kosten</span><span class="num">' + money(r.summe) + '</span></div>'
                  + row('Vorauszahlungen', money(r.gezahlt), 'sub')
                  + row(r.saldo >= 0 ? 'Nachzahlung' : 'Guthaben', money(Math.abs(r.saldo)),
                      r.saldo >= 0 ? 'warn' : 'sub')
                  + row('Neue Vorauszahlung', money(r.neu), 'sub')
                  + '<button class="tiny" data-act="nk-text" data-uid="' + r.unit.id + '">Abrechnung kopieren</button>'
                  + '</div>';
              }).join('')
            + '</div>'
            + '<div class="legal">Verteilt wird nach Wohnfläche, je Einheit oder nach Verbrauch. '
            + 'Nicht umlagefähig sind unter anderem Verwaltungskosten, Instandhaltung und Reparaturen — '
            + 'die gehören nicht in diese Aufstellung. Die Abrechnung muss dem Mieter binnen zwölf Monaten '
            + 'nach Ende des Abrechnungszeitraums zugehen.</div></div>';
        }
      }

      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'schreiben') {
      const o = findObj(modal.oid);
      const x = o.units.find(function (z) { return z.id === modal.uid; });
      const art = modal.art || 'erhoehung';
      const text = schreibenText(art, o, x);

      body = '<h2>Schreiben</h2>'
        + '<div class="hint">' + esc(x.name) + ' · ' + esc(x.tenant || 'kein Mieter')
        + ' — Vorlage wählen, Text prüfen, kopieren oder drucken. Platzhalter in eckigen Klammern füllst du selbst.</div>'
        + '<div class="vorlagen">'
        + VORLAGEN.map(function (v) {
            return '<button class="tiny' + (art === v.id ? ' primary' : '') + '" '
              + 'data-act="schreiben-art" data-a="' + v.id + '">' + v.name + '</button>';
          }).join('')
        + '</div>'
        + '<textarea id="brief" rows="18" class="brieftext">' + esc(text) + '</textarea>'
        + '<div class="modal-actions" style="justify-content:flex-start">'
        + '<button class="primary" data-act="brief-kopieren">Text kopieren</button>'
        + '<button data-act="brief-drucken">Drucken</button></div>'
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'google') {
      body = '<h2>Postfach</h2>'
        + '<div class="hint">Die App liest deine Mails nur mit — sie kann nichts senden, ändern oder löschen. '
        + 'In deinen Kalender schreibt sie nur in den eigenen Kalender „Aufgaben“, deine anderen Termine bleiben unberührt. '
        + 'Das Zugriffsrecht kannst du bei Google jederzeit widerrufen.</div>'
        + (google.verbunden
            ? '<div class="hintbox">Verbunden mit ' + esc(google.adresse || 'deinem Postfach') + '</div>'
              + '<div class="divider"></div>'
              + '<div class="spalte-titel">Was in der Übersicht landet</div>'
              + f('Zusätzliche Stichworte', '<input type="text" id="pf-worte" value="'
                  + esc(postFilter ? postFilter.stichworte : '')
                  + '" placeholder="Meier GmbH, Elektro Bauer, Kaminkehrer">')
              + f('Nie anzeigen, wenn enthalten', '<input type="text" id="pf-aus" value="'
                  + esc(postFilter ? postFilter.ausschluss : '')
                  + '" placeholder="newsletter, amazon, paypal">')
              + '<div class="legal">Mehrere Begriffe mit Komma trennen. Der Ausschluss greift zuerst — '
              + 'er blendet auch Mails aus, die sonst passen würden.</div>'
              + '<div class="modal-actions" style="justify-content:flex-start">'
              + '<button class="primary" data-act="pf-speichern">Filter speichern</button>'
              + '<button class="danger" data-act="google-trennen">Verbindung lösen</button>'
              + '<a class="tdlink" href="/api/google/start" title="Etwa, um dem Tagesplan den Kalender „Aufgaben“ zu erlauben">Neu anmelden</a></div>'
              + '<div class="divider"></div>'
              + '<div class="spalte-titel">Nachschauen, was Google liefert</div>'
              + '<div class="aufgabe-neu">'
              + '<input type="text" id="pf-suche" placeholder="z. B. immoscout oder Name der Interessentin">'
              + '<button class="tiny" data-act="pf-suchen">Suchen</button></div>'
              + (modal.suche
                  ? '<div class="doclist" style="margin-top:10px">'
                    + '<div class="docrow"><div class="grow"><strong>' + esc(modal.suche.postfach || '?') + '</strong>'
                    + '<div class="unit-type">' + (modal.suche.gesamtImPostfach || '?') + ' Mails im Postfach · '
                    + modal.suche.gefunden + ' Treffer</div></div></div>'
                    + (modal.suche.mails || []).map(function (m) {
                        return '<div class="docrow"><div class="grow">' + esc(m.betreff)
                          + '<div class="unit-type">' + esc(m.von) + ' · '
                          + (m.wann ? new Date(m.wann).toLocaleDateString('de-DE') : '') + '</div>'
                          + '<div class="unit-type">Ordner: ' + esc(m.labels) + '</div></div></div>';
                      }).join('')
                    + '</div>'
                  : '')
            : f('Client-ID', '<input type="text" id="g-id" placeholder="…apps.googleusercontent.com">')
              + f('Client-Secret', '<input type="password" id="g-secret">')
              + '<div class="modal-actions" style="justify-content:flex-start">'
              + '<button class="primary" data-act="google-speichern">Speichern</button>'
              + (google.eingerichtet
                  ? '<a class="tdlink" href="/api/google/start">Jetzt mit Google anmelden</a>' : '')
              + '</div>'
              + '<div class="legal">Client-ID und Secret erzeugst du einmalig in der Google Cloud Console. '
              + 'Als Weiterleitungs-URL trägst du dort ein: https://zieglerverwaltung.immobilien/api/google/zurueck</div>')
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'gkal') {
      body = '<h2>Kalender</h2>'
        + '<div class="hint">Die App zeigt die Termine deines Google-Kalenders im Tagesplan an — '
        + 'zwischen deinen Aufgaben und Besichtigungen. Dafür genügt die private iCal-Adresse, '
        + 'die App liest nur mit und kann nichts ändern.</div>'
        + (gkal.eingerichtet
            ? '<div class="hintbox">Der Kalender ist verbunden. Neue Termine tauchen spätestens nach fünf Minuten auf.</div>'
              + '<div class="modal-actions" style="justify-content:flex-start">'
              + '<button data-act="gkal-frisch">Jetzt neu laden</button>'
              + '<button class="danger" data-act="gkal-trennen">Verbindung lösen</button></div>'
            : f('Private iCal-Adresse', '<input type="text" id="gk-url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">')
              + '<div class="modal-actions" style="justify-content:flex-start">'
              + '<button class="primary" data-act="gkal-speichern">Verbinden</button></div>'
              + '<div class="legal">So findest du die Adresse: Google Kalender am PC öffnen → Zahnrad → Einstellungen → '
              + 'links unter „Einstellungen für meine Kalender" deinen Kalender anklicken → Abschnitt „Kalender integrieren" → '
              + 'dort die „Privatadresse im iCal-Format" kopieren. Die Adresse ist geheim — wer sie kennt, kann deine Termine lesen.</div>')
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'gkal-info') {
      const g = (gkalListe || []).find(function (x) { return x.id === modal.id; });
      body = '<h2>' + esc(g ? g.titel : 'Termin') + '</h2>'
        + (g
            ? '<div class="hintbox">'
              + esc(new Date(g.tag + 'T12:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))
              + (g.ganztags ? ' · ganztägig'
                  : ' · ' + g.start.slice(11, 16) + (g.ende ? '–' + g.ende.slice(11, 16) : '') + ' Uhr')
              + '</div>'
              + (g.ort ? '<div class="field"><label>Ort</label><div>' + esc(g.ort) + '</div></div>' : '')
              + (g.notiz ? '<div class="field"><label>Notiz</label>'
                  + '<div style="white-space:pre-wrap;font-size:13px">' + esc(g.notiz.slice(0, 1200)) + '</div></div>' : '')
            : '<div class="hint">Der Termin ist gerade nicht geladen.</div>')
        + '<div class="legal">Aus deinem Google-Kalender — ändern kannst du ihn dort.</div>'
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'assistent') {
      body = '<h2>Assistent</h2>'
        + '<div class="hint">Mit einem Schlüssel von Anthropic kannst du in die App sprechen: '
        + '„Trag ein, Kaminkehrer anrufen bei Bertha, nächsten Dienstag." Der Assistent legt die '
        + 'Aufgabe in Todoist an, hakt Erledigtes ab, verschiebt Termine und antwortet gesprochen. '
        + 'Auch das kostet nur Cent-Beträge im Monat.</div>'
        + (stimme.verbunden ? ''
            : '<div class="hintbox">Zum Zuhören wird zusätzlich der Schlüssel der Vorlesestimme gebraucht — '
              + 'den richtest du unter „Vorlesestimme" ein.</div>');

      if (!assistent.verbunden) {
        body += '<div class="field"><label>Schlüssel</label>'
          + '<input type="password" id="as-token" placeholder="beginnt mit sk-ant-…"></div>'
          + '<div class="legal">So kommst du daran: console.anthropic.com öffnen, anmelden, '
          + 'unter „Billing" einmal Guthaben aufladen, dann unter „API keys" einen Schlüssel erzeugen. '
          + 'Das ist ein eigenes Konto für Entwickler — ein Claude-Abo reicht dafür nicht. '
          + 'Der Schlüssel bleibt auf deinem Server.</div>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="assistent-speichern">Verbinden</button></div>';
      } else {
        body += '<div class="hintbox">Verbunden. Auf der Startseite steht jetzt der Knopf „Sagen".</div>'
          + '<div class="field"><label>Schlüssel ersetzen</label>'
          + '<input type="password" id="as-token" placeholder="nur ausfüllen, wenn du einen neuen hast">'
          + '<div class="modal-actions" style="justify-content:flex-start;margin-top:8px">'
          + '<button class="primary" data-act="assistent-speichern">Schlüssel übernehmen</button></div></div>'
          + '<div class="field"><label>Was er darf</label>'
          + '<div class="unit-type">Aufgaben anlegen, abhaken und verschieben — und Fragen zum heutigen '
          + 'Tag beantworten. An Mieten, Objekten und Verträgen ändert er nichts.</div></div>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="danger" data-act="assistent-trennen">Schlüssel entfernen</button></div>';
      }
      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'stimme') {
      body = '<h2>Vorlesestimme</h2>'
        + '<div class="hint">Mit einem Schlüssel von OpenAI liest eine echte Stimme die Tagesmemo vor — '
        + 'deutlich natürlicher als die eingebaute Handystimme. Abgerechnet wird nach Zeichen; '
        + 'eine Memo am Tag kostet etwa 40 Cent im Monat. Jede Aufnahme wird auf deinem Server '
        + 'gespeichert, mehrmaliges Anhören kostet nichts.</div>';

      if (!stimme.verbunden) {
        body += '<div class="field"><label>Schlüssel</label>'
          + '<input type="password" id="ki-token" placeholder="beginnt mit sk-…"></div>'
          + '<div class="legal">So kommst du an den Schlüssel: platform.openai.com öffnen, anmelden, '
          + 'unter „Billing" einmal Guthaben aufladen (5 $ reichen für Jahre), dann unter „API keys" '
          + 'einen neuen Schlüssel erzeugen und hier einfügen. Er wird auf deinem Server gespeichert '
          + 'und ist im Browser nie sichtbar.</div>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="stimme-speichern">Verbinden</button></div>';
      } else {
        body += '<div class="hintbox">Verbunden. Die Memo wird jetzt mit dieser Stimme vorgelesen.</div>'
          + '<div class="field"><label>Schlüssel ersetzen</label>'
          + '<input type="password" id="ki-token" placeholder="nur ausfüllen, wenn du einen neuen hast"></div>'
          + '<div class="field"><label>Stimme</label><select id="ki-stimme">'
          + KI_STIMMEN.map(function (v) {
              return '<option value="' + v[0] + '"' + (v[0] === stimme.stimme ? ' selected' : '') + '>'
                + esc(v[1]) + '</option>';
            }).join('')
          + '</select></div>'
          + '<div class="field"><label>Sprechweise</label>'
          + '<textarea id="ki-anweisung" rows="3">' + esc(stimme.anweisung || '') + '</textarea></div>'
          + '<div class="legal">Die Sprechweise kannst du in eigenen Worten beschreiben — '
          + 'zum Beispiel „langsamer und sachlich" oder „freundlich, mit Pausen".</div>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="stimme-speichern">Speichern</button>'
          + '<button data-act="stimme-probe">Hörprobe</button>'
          + '<button class="danger" data-act="stimme-trennen">Schlüssel entfernen</button></div>';
      }
      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'todoist') {
      body = '<h2>Todoist</h2>'
        + '<div class="hint">Fällige Prüfungen, Fristen und Mieterhöhungen landen als Aufgaben im '
        + 'passenden Projekt. Jede Aufgabe wird nur einmal angelegt.</div>';

      if (!todoist.verbunden) {
        body += '<div class="field"><label>API-Token</label>'
          + '<input type="password" id="td-token" placeholder="aus Todoist: Einstellungen › Integrationen › Entwickler"></div>'
          + '<div class="legal">Das Token wird auf deinem Server gespeichert und verlässt ihn nur Richtung Todoist. '
          + 'Im Browser ist es nie sichtbar.</div>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="td-speichern">Verbinden</button></div>';
      } else {
        body += '<div class="hintbox">Verbunden. Ordne jedem Objekt sein Todoist-Projekt zu.</div>'
          + data.objects.map(function (o) {
              return '<div class="field"><label>' + esc(o.name) + '</label>'
                + '<select id="td-' + o.id + '"><option value="">— kein Projekt —</option>'
                + todoistProjekte.map(function (pr) {
                    return '<option value="' + pr.id + '"'
                      + (todoist.zuordnung[o.id] === pr.id ? ' selected' : '') + '>' + esc(pr.name) + '</option>';
                  }).join('')
                + '</select></div>';
            }).join('')
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="td-speichern">Zuordnung speichern</button>'
          + '<button data-act="td-senden">Jetzt übertragen</button>'
          + '<button class="danger" data-act="td-trennen">Verbindung lösen</button></div>';
      }
      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'konto') {
      const o = findObj(modal.oid);
      const monate = letzteMonate(6);
      const aktiv = o.units.filter(function (x) { return x.status === 'vermietet'; });

      body = '<h2>Mietkonto ' + esc(o.name) + '</h2>'
        + '<div class="hint">Trag ein, was tatsächlich eingegangen ist. Leer heißt „noch nicht geprüft", '
        + '0 heißt „nichts gekommen". Die Sollmiete steht als Vorgabe im Feld.</div>';

      if (!aktiv.length) {
        body += '<div class="docempty">Keine vermieteten Einheiten.</div>';
      } else {
        if (mobil) {
          body += aktiv.map(function (x) {
            const offen = kontoSaldo(x, monate);
            return '<div class="ekarte" style="cursor:default">'
              + '<div class="ekopf"><div class="ename">' + esc(x.name) + '</div>'
              + '<span class="num ' + (offen > 0.5 ? 'rueckstand' : '') + '">'
              + (offen > 0.5 ? money(offen) + ' offen' : (offen < -0.5 ? '+' + money(-offen) : 'ausgeglichen')) + '</span></div>'
              + '<div class="emieter">' + esc(x.tenant || '—') + ' · Soll ' + money(soll(x)) + '</div>'
              + '<div class="monatsgitter">'
              + monate.map(function (m) {
                  const wert = (x.zahlungen && x.zahlungen[m.schluessel] != null) ? x.zahlungen[m.schluessel] : '';
                  return '<label class="monat"><span>' + m.kurz + '</span>'
                    + '<input type="number" step="0.01" inputmode="decimal" '
                    + 'id="k-' + x.id + '-' + m.schluessel + '" value="' + wert + '" '
                    + 'placeholder="' + soll(x).toFixed(0) + '"></label>';
                }).join('')
              + '</div></div>';
          }).join('');
          const summeOffen = aktiv.reduce(function (a, x) { return a + Math.max(0, kontoSaldo(x, monate)); }, 0);
          body += '<div class="sum-line"><span>Rückstände gesamt</span><span class="num">'
            + (summeOffen > 0.5 ? money(summeOffen) : '—') + '</span></div>';
        } else {
        body += '<table><thead><tr><th>Einheit</th><th class="right">Soll</th>'
          + monate.map(function (m) { return '<th class="right">' + m.kurz + '</th>'; }).join('')
          + '<th class="right">Offen</th></tr></thead><tbody>';
        aktiv.forEach(function (x) {
          const offen = kontoSaldo(x, monate);
          body += '<tr><td><div class="unit-name">' + esc(x.name) + '</div>'
            + '<div class="unit-type">' + esc(x.tenant || '—') + '</div></td>'
            + '<td class="right num">' + money(soll(x)) + '</td>'
            + monate.map(function (m) {
                const wert = (x.zahlungen && x.zahlungen[m.schluessel] != null) ? x.zahlungen[m.schluessel] : '';
                return '<td><input type="number" step="0.01" style="min-width:78px" '
                  + 'id="k-' + x.id + '-' + m.schluessel + '" value="' + wert + '" '
                  + 'placeholder="' + soll(x).toFixed(2) + '"></td>';
              }).join('')
            + '<td class="right num ' + (offen > 0.5 ? 'rueckstand' : '') + '">'
            + (offen > 0.5 ? money(offen) : (offen < -0.5 ? '+' + money(-offen) : '—')) + '</td></tr>';
        });
        const summeOffen = aktiv.reduce(function (a, x) { return a + Math.max(0, kontoSaldo(x, monate)); }, 0);
        body += '</tbody><tfoot><tr><td colspan="' + (monate.length + 2) + '">Rückstände gesamt</td>'
          + '<td class="right num ' + (summeOffen > 0.5 ? 'rueckstand' : '') + '">'
          + (summeOffen > 0.5 ? money(summeOffen) : '—') + '</td></tr></tfoot></table>'
        }
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="konto-speichern">Speichern</button></div>';
      }
      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'wartung') {
      const o = findObj(modal.oid);
      const liste = o.pruefungen || [];
      const heute = new Date();

      body = '<h2>Prüfungen und Wartung</h2>'
        + '<div class="hint">' + esc(o.name) + ' · Trag ein, wann zuletzt geprüft wurde. '
        + 'Den nächsten Termin rechnet die App aus und meldet ihn 60 Tage vorher oben auf der Startseite.</div>';

      if (!liste.length) {
        body += '<div class="docempty">Noch keine Prüfungen erfasst.</div>'
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="pruef-vorlage">Übliche Prüfungen anlegen</button></div>';
      } else {
        if (mobil) {
          body += liste.map(function (pr, i) {
            const naechste = pr.letzte ? monateDazu(pr.letzte, pr.intervall) : null;
            const spaet = naechste && naechste < heute;
            return '<div class="ekarte" style="cursor:default">'
              + '<div class="feldchen"><span>Prüfung</span>'
              + '<input type="text" id="w-n-' + i + '" value="' + esc(pr.name) + '"></div>'
              + '<div class="feldpaar">'
              + '<label class="feldchen"><span>Zuletzt</span>'
              + '<input type="date" id="w-d-' + i + '" value="' + esc(pr.letzte || '') + '"></label>'
              + '<label class="feldchen"><span>Alle X Monate</span>'
              + '<input type="number" inputmode="numeric" id="w-i-' + i + '" value="' + (pr.intervall || '') + '"></label>'
              + '</div>'
              + '<div class="ekopf" style="margin-top:9px">'
              + '<span class="unit-type">Nächste: <span class="num ' + (spaet ? 'rueckstand' : '') + '">'
              + (naechste ? naechste.toLocaleDateString('de-DE') : '—') + '</span></span>'
              + '<button class="tiny ghost" data-act="pruef-weg" data-i="' + i + '">Entfernen</button>'
              + '</div></div>';
          }).join('');
        } else {
        body += '<table><thead><tr><th>Prüfung</th><th>Zuletzt</th><th class="right">Alle X Monate</th>'
          + '<th>Nächste</th><th></th></tr></thead><tbody>';
        liste.forEach(function (pr, i) {
          const naechste = pr.letzte ? monateDazu(pr.letzte, pr.intervall) : null;
          const spaet = naechste && naechste < heute;
          body += '<tr><td><input type="text" id="w-n-' + i + '" value="' + esc(pr.name) + '" style="min-width:170px"></td>'
            + '<td><input type="date" id="w-d-' + i + '" value="' + esc(pr.letzte || '') + '"></td>'
            + '<td><input type="number" id="w-i-' + i + '" value="' + (pr.intervall || '') + '" style="min-width:70px"></td>'
            + '<td class="num ' + (spaet ? 'rueckstand' : '') + '">'
            + (naechste ? naechste.toLocaleDateString('de-DE') : '—') + '</td>'
            + '<td><button class="tiny ghost" data-act="pruef-weg" data-i="' + i + '">Weg</button></td></tr>';
          });
          body += '</tbody></table>';
        }
        body += '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="pruef-speichern">Speichern</button>'
          + '<button data-act="pruef-neu">Zeile hinzufügen</button></div>';
      }
      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'strom') {
      const o = findObj(modal.oid);
      const p = pvEinstellungen(o);
      const anteil = stromAnteil(o);
      const wohnungen = o.units.filter(function (x) {
        return parkTypes.indexOf(x.type) === -1 && x.status === 'vermietet';
      });

      body = '<h2>Stromabrechnung ' + p.jahr + '</h2>'
        + '<div class="hint">Solarstrom kostet ' + p.rabatt + ' % weniger als der Grundversorgungstarif, '
        + 'Netzstrom zum Preis des Versorgers. Aufgeteilt wird nach dem Mix der Anlage.</div>'
        + '<div class="pv-raster">'
        + f('Abrechnungsjahr', '<input type="number" id="pv-jahr" value="' + p.jahr + '">')
        + f('Nachlass Solar (%)', '<input type="number" id="pv-rabatt" step="0.1" value="' + (p.rabatt == null ? '' : p.rabatt) + '">')
        + f('Grundversorgung ct/kWh', '<input type="number" id="pv-arbeit" step="0.01" value="' + (p.arbeitspreis == null ? '' : p.arbeitspreis) + '" placeholder="39,23">')
        + f('Grundpreis €/Monat', '<input type="number" id="pv-grund" step="0.01" value="' + (p.grundpreis == null ? '' : p.grundpreis) + '" placeholder="14,88">')
        + f('Netzstrom ct/kWh', '<input type="number" id="pv-netz" step="0.01" value="' + (p.netzpreis == null ? '' : p.netzpreis) + '">')
        + f('Netz-Grundpreis €/Monat', '<input type="number" id="pv-netzgrund" step="0.01" value="' + (p.netzGrundpreis == null ? '' : p.netzGrundpreis) + '">')
        + f('Solarertrag kWh (Jahr)', '<input type="number" id="pv-solar" step="1" value="' + (p.solarKwh == null ? '' : p.solarKwh) + '">')
        + f('Netzbezug kWh (Jahr)', '<input type="number" id="pv-netzkwh" step="1" value="' + (p.netzKwh == null ? '' : p.netzKwh) + '">')
        + '</div>'
        + (anteil ? '<div class="sum-line"><span>Strommix</span><span class="num">'
            + Math.round(anteil * 100) + ' % Solar · ' + Math.round((1 - anteil) * 100) + ' % Netz</span></div>' : '')
        + '<div class="divider"></div>';

      if (!wohnungen.length) {
        body += '<div class="docempty">Keine vermieteten Wohnungen erfasst.</div>';
      } else {
        if (mobil) {
          body += wohnungen.map(function (x) {
            return '<div class="ekarte" style="cursor:default">'
              + '<div class="ekopf"><div class="ename">' + esc(x.name) + '</div>'
              + '<span class="unit-type">' + esc(x.tenant || '—') + '</span></div>'
              + '<div class="feldpaar">'
              + '<label class="feldchen"><span>Zählernummer</span>'
              + '<input type="text" id="z-' + x.id + '" value="' + esc(x.zaehler || '') + '"></label>'
              + '<label class="feldchen"><span>Stand alt</span>'
              + '<input type="number" inputmode="numeric" id="a-' + x.id + '" value="' + (x.kwhStart == null ? '' : x.kwhStart) + '"></label>'
              + '<label class="feldchen"><span>Stand neu</span>'
              + '<input type="number" inputmode="numeric" id="e-' + x.id + '" value="' + (x.kwhEnde == null ? '' : x.kwhEnde) + '"></label>'
              + '<label class="feldchen"><span>Abschlag</span>'
              + '<input type="number" step="0.01" inputmode="decimal" id="b-' + x.id + '" value="' + (x.abschlagStrom == null ? '' : x.abschlagStrom) + '"></label>'
              + '<label class="feldchen"><span>Monate</span>'
              + '<input type="number" inputmode="numeric" id="m-' + x.id + '" value="' + (x.monateStrom == null ? 12 : x.monateStrom) + '"></label>'
              + '</div></div>';
          }).join('');
        } else {
        body += '<table><thead><tr>'
          + '<th>Einheit</th><th>Zähler</th><th class="right">Stand alt</th><th class="right">Stand neu</th>'
          + '<th class="right">Abschlag</th><th class="right">Monate</th></tr></thead><tbody>';
        wohnungen.forEach(function (x) {
          body += '<tr><td><div class="unit-name">' + esc(x.name) + '</div>'
            + '<div class="unit-type">' + esc(x.tenant || '—') + '</div></td>'
            + '<td><input type="text" id="z-' + x.id + '" value="' + esc(x.zaehler || '') + '" style="min-width:90px"></td>'
            + '<td><input type="number" id="a-' + x.id + '" value="' + (x.kwhStart == null ? '' : x.kwhStart) + '" style="min-width:80px"></td>'
            + '<td><input type="number" id="e-' + x.id + '" value="' + (x.kwhEnde == null ? '' : x.kwhEnde) + '" style="min-width:80px"></td>'
            + '<td><input type="number" id="b-' + x.id + '" step="0.01" value="' + (x.abschlagStrom == null ? '' : x.abschlagStrom) + '" style="min-width:70px"></td>'
            + '<td><input type="number" id="m-' + x.id + '" value="' + (x.monateStrom == null ? 12 : x.monateStrom) + '" style="min-width:55px"></td>'
            + '</tr>';
        });
        body += '</tbody></table>'
        }
          + '<div class="modal-actions" style="justify-content:flex-start">'
          + '<button class="primary" data-act="pv-rechnen">Berechnen und speichern</button></div>';

        // Ergebnis, sofern gerechnet werden kann
        if (n(p.arbeitspreis) && anteil) {
          body += '<div class="divider"></div><div class="breakdown"><h3>Ergebnis</h3><div class="pv-ergebnis">';
          wohnungen.forEach(function (x) {
            const r = stromRechnung(o, x);
            if (!r.verbrauch) return;
            body += '<div class="niveau-block"><strong>' + esc(x.name) + ' · ' + esc(x.tenant || '') + '</strong>'
              + row('Verbrauch', Math.round(r.verbrauch) + ' kWh')
              + row('davon Solar', Math.round(r.solarKwh) + ' kWh', 'sub')
              + row('davon Netz', Math.round(r.netzKwh) + ' kWh', 'sub')
              + row('Arbeitspreis', money(r.arbeitSolar + r.arbeitNetz), 'sub')
              + row('Grundpreis', money(r.grund), 'sub')
              + '<div class="brow total"><span>Kosten gesamt</span><span class="num">' + money(r.summe) + '</span></div>'
              + row('Abschläge gezahlt', money(r.gezahlt), 'sub')
              + row(r.saldo >= 0 ? 'Nachzahlung' : 'Guthaben', money(Math.abs(r.saldo)), r.saldo >= 0 ? 'warn' : 'sub')
              + row('Neuer Abschlag empfohlen', money(r.neuerAbschlag) + ' / Monat', 'sub')
              + '<button class="tiny" data-act="pv-text" data-uid="' + x.id + '">Abrechnungstext kopieren</button>'
              + '</div>';
          });
          body += '</div></div>';
        }
      }

      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';

    } else if (modal.kind === 'sicherung') {
      body = '<h2>Daten sichern</h2>'
        + '<div class="hint">Eine zusätzliche Kopie deiner Daten für dieses Gerät — normalerweise nicht nötig, '
        + 'denn der Server sichert jede Nacht selbst (Menü → Server-Sicherung). Zum Zurückholen fügst du den Text unten wieder ein.</div>'
        + '<div class="field"><label>Deine Daten</label>'
        + '<textarea id="m-json" rows="6" readonly>' + esc(JSON.stringify(data)) + '</textarea></div>'
        + '<div class="modal-actions" style="justify-content:flex-start;margin-top:0">'
        + '<button class="primary" data-act="json-kopieren">Text kopieren</button>'
        + '<button data-act="json-download">Download versuchen</button></div>'
        + '<div class="divider"></div>'
        + '<div class="field"><label>Sicherung zurückholen</label>'
        + '<textarea id="m-jsonein" rows="4" placeholder="Gesicherten Text hier einfügen"></textarea></div>'
        + '<button data-act="json-einlesen">Daten einlesen</button>'
        + '<div class="legal">Einlesen ersetzt alles, was gerade in der App steht.</div>'
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';
    } else if (modal.kind === 'zugaenge') {
      body = '<h2>Zugänge</h2>'
        + '<div class="hint">Alle hier aufgeführten Personen arbeiten mit denselben Daten. '
        + 'Benutzername und Passwort vergibst du.</div>'
        + '<div class="doclist">' + (nutzerListe.length ? nutzerListe.map(function (nu) {
            return '<div class="docrow"><div class="grow"><strong>' + esc(nu.name) + '</strong>'
              + '<div class="unit-type">' + (nu.name === nutzerName ? 'das bist du · ' : '')
              + (nu.rolle === 'verwalter' ? 'Verwalter · ' : '')
              + 'seit ' + new Date(nu.angelegt).toLocaleDateString('de-DE') + '</div></div>'
              + (nu.name === nutzerName || nutzerRolle !== 'verwalter' ? ''
                  : '<button class="tiny ghost" data-act="nutzer-pw" data-name="' + esc(nu.name) + '">Passwort neu</button>'
                    + '<button class="tiny ghost" data-act="nutzer-weg" data-name="' + esc(nu.name) + '">Entfernen</button>')
              + '</div>';
          }).join('') : '<div class="docempty">Wird geladen …</div>') + '</div>'
        + (nutzerRolle !== 'verwalter' ? '' : '<div class="divider"></div>'
        + '<div class="two">'
        + f('Neuer Benutzername', '<input type="text" id="n-name" placeholder="z. B. Papa">')
        + f('Passwort', '<input type="password" id="n-pw" placeholder="mind. 8 Zeichen">')
        + '</div>'
        + '<button class="primary" data-act="nutzer-neu">Zugang anlegen</button>'
        + '<div class="legal">Gib die Zugangsdaten persönlich weiter. Ein entfernter Zugang wird sofort '
        + 'abgemeldet und kommt nicht mehr rein.</div>')
        + '<div class="divider"></div>'
        + '<div class="two">'
        + f('Bisheriges Passwort', '<input type="password" id="pw-alt" autocomplete="current-password">')
        + f('Neues Passwort', '<input type="password" id="pw-neu" placeholder="mind. 8 Zeichen" autocomplete="new-password">')
        + '</div>'
        + '<button data-act="pw-aendern">Eigenes Passwort ändern</button>'
        + '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';
    } else if (modal.kind === 'plan') {
      const p = planInfo;
      body = '<h2>Tagesplan</h2>';
      if (!p || p.fehler) {
        body += '<div class="docempty">' + (p ? esc(p.fehler) : 'Wird berechnet …') + '</div>';
      } else {
        body += '<div class="hint">So würde ich ' + (p.datum === heuteISO() ? 'deinen Tag' : 'den ' + esc(planTag(p.datum))) + ' legen. '
          + '„Übernehmen“ trägt Uhrzeit und Dauer in Todoist ein; was heute nicht mehr passt, bekommt ein neues Datum. '
          + 'Mit „Rückgängig“ ist alles wieder wie vorher.</div>';
        const heute = p.bloecke.map(function (b) {
          return { von: b.von, html: '<div class="planblock"><span class="num">' + b.von + '–' + b.bis + '</span>'
            + '<span class="grow">' + esc(b.inhalt) + '</span>'
            + '<span class="unit-type">' + b.dauer + ' Min' + (b.geschaetzt ? ', geschätzt' : '') + (b.ohneDatum ? ' · hatte kein Datum' : '') + '</span></div>' };
        }).concat(p.fest.map(function (f) {
          return { von: f.von, html: '<div class="planblock fest"><span class="num">' + f.von + '–' + f.bis + '</span>'
            + '<span class="grow">' + esc(f.inhalt) + '</span><span class="unit-type">feste Uhrzeit</span></div>' };
        })).sort(function (a, c) { return a.von < c.von ? -1 : 1; });
        body += '<div class="plantitel">Heute</div>'
          + (heute.length ? heute.map(function (z) { return z.html; }).join('') : '<div class="docempty">Heute ist kein Platz mehr frei.</div>');
        if (p.verschoben.length) {
          const tage = {};
          p.verschoben.forEach(function (v) { (tage[v.nach] = tage[v.nach] || []).push(v.inhalt); });
          body += '<div class="plantitel">Auf die nächsten Tage (' + p.verschoben.length + ')</div>'
            + Object.keys(tage).sort().map(function (d) {
                return '<div class="plangruppe"><b>' + esc(planTag(d)) + '</b> ' + tage[d].map(esc).join(' · ') + '</div>';
              }).join('');
        }
        if (p.eingeplant && p.eingeplant.length) {
          const tageO = {};
          p.eingeplant.forEach(function (v) { (tageO[v.nach] = tageO[v.nach] || []).push(v.inhalt); });
          body += '<div class="plantitel">Ohne Datum, jetzt eingeplant (' + p.eingeplant.length + ')</div>'
            + Object.keys(tageO).sort().map(function (d) {
                return '<div class="plangruppe"><b>' + esc(planTag(d)) + '</b> ' + tageO[d].map(esc).join(' · ') + '</div>';
              }).join('');
        }
        if (p.bleibtHeute && p.bleibtHeute.length) {
          body += '<div class="plantitel">Bleibt heute, ohne feste Uhrzeit (' + p.bleibtHeute.length + ')</div>'
            + '<div class="plangruppe">' + p.bleibtHeute.map(function (b) { return esc(b.inhalt); }).join(' · ') + '</div>';
        }
        if (p.wiederkehrend.length) {
          body += '<div class="unit-type" style="margin-top:10px">Wiederkehrend, bleibt wie es ist: '
            + p.wiederkehrend.map(function (w) { return esc(w.inhalt); }).join(' · ') + '</div>';
        }
        if (p.ohnePlatz.length) {
          body += '<div class="unit-type" style="margin-top:6px">Kein Platz in den nächsten Wochen: '
            + p.ohnePlatz.map(function (w) { return esc(w.inhalt); }).join(' · ') + '</div>';
        }
        if (nutzerRolle === 'verwalter' && planEinst && !planEinst.automatisch) {
          body += '<label class="planauto"><input type="checkbox" id="plan-auto"> Ab jetzt jeden Morgen automatisch so planen</label>';
        }
      }
      body += '<div class="modal-actions">'
        + '<button class="primary" data-act="plan-uebernehmen"' + (planLaeuft || !p || p.fehler || !p.aenderungen ? ' disabled' : '') + '>'
        + (planLaeuft ? 'Trage ein …' : 'Übernehmen') + '</button>'
        + '<div class="spacer"></div><button data-act="close">Abbrechen</button></div>';
    } else if (modal.kind === 'planeinst') {
      const e = planEinst || {};
      const darf = nutzerRolle === 'verwalter';
      const aus = darf ? '' : ' disabled';
      const zeit = function (id, wert) { return '<input type="time" id="' + id + '" value="' + esc(wert || '') + '"' + aus + '>'; };
      const zahl = function (id, wert, schritt) {
        return '<input type="number" id="' + id + '" value="' + esc(String(wert)) + '" step="' + (schritt || 1) + '" min="0"' + aus + '>';
      };
      const tage = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
      body = '<h2>Tagesplan einstellen</h2>'
        + '<div class="hint">In diesem Rahmen legt der Planer deine Aufgaben. Termine aus dem Kalender, Besichtigungen '
        + 'und Aufgaben mit fester Uhrzeit hält er frei.</div>'
        + '<div class="two">' + f('Arbeitsbeginn', zeit('pe-start', e.start)) + f('Arbeitsende', zeit('pe-ende', e.ende)) + '</div>'
        + '<div class="two">' + f('Pause von', zeit('pe-pvon', e.pauseVon)) + f('Pause bis', zeit('pe-pbis', e.pauseBis)) + '</div>'
        + '<div class="two">' + f('Höchstens verplant pro Tag (Stunden)', zahl('pe-max', (e.maxMinuten || 360) / 60, 0.5))
        + f('Luft nach jedem Block (Minuten)', zahl('pe-puffer', e.puffer === undefined ? 10 : e.puffer)) + '</div>'
        + '<div class="two">' + f('Dauer, wenn nichts bekannt (Minuten)', zahl('pe-dauer', e.standardDauer || 30, 5)) + '<div></div></div>'
        + f('Arbeitstage', '<div class="plantage">' + tage.map(function (t) {
            return '<label><input type="checkbox" class="pe-tag" value="' + t[0] + '"'
              + ((e.arbeitstage || [1, 2, 3, 4, 5]).indexOf(t[0]) !== -1 ? ' checked' : '') + aus + '> ' + t[1] + '</label>';
          }).join('') + '</div>')
        + '<label class="planauto"><input type="checkbox" id="pe-auto"' + (e.automatisch ? ' checked' : '') + aus + '> '
        + 'Jeden Morgen automatisch planen und in Todoist eintragen</label>'
        + '<label class="planauto"><input type="checkbox" id="pe-ohne"' + (e.ohneDatum !== false ? ' checked' : '') + aus + '> '
        + 'Aufgaben ohne Datum selbst einplanen (in freie Zeit der nächsten zwei Wochen)</label>'
        + (function () {
            // Google-Kalender „Aufgaben“: eingerichtet, braucht neue Verbindung, oder Fehler
            const k = e.kalender || {};
            let zeile;
            if (k.erlaubt && k.fehler) zeile = '<span style="color:var(--sperr)">' + esc(k.fehler) + '</span>';
            else if (k.erlaubt) zeile = 'Jeder geplante Block steht auch in deinem Google-Kalender „Aufgaben“.';
            else if (k.verbunden) zeile = 'Damit die Blöcke in deinem Google-Kalender „Aufgaben“ erscheinen, Google einmal neu verbinden und den Kalender-Zugriff erlauben.';
            else zeile = 'Mit Google verbunden trägt der Planer jeden Block in einen eigenen Kalender „Aufgaben“ ein.';
            return '<div class="plankal"><strong>Google-Kalender</strong><div class="unit-type">' + zeile + '</div>'
              + (!k.erlaubt && darf
                  ? (k.verbunden
                      ? '<a class="tdlink" href="/api/google/start" style="display:inline-block;margin-top:8px">Google neu verbinden</a>'
                      : '<button class="tiny" data-act="google" style="margin-top:8px">Google verbinden</button>')
                  : '')
              + '</div>';
          })()
        + (darf ? '' : '<div class="legal">Nur der Verwalter kann das ändern.</div>')
        + '<div class="modal-actions">'
        + (darf ? '<button class="primary" data-act="plan-einst-speichern">Speichern</button>' : '')
        + '<div class="spacer"></div><button data-act="close">Schließen</button></div>';
    } else if (modal.kind === 'serversicherung') {
      const si = sicherungInfo;
      const zeit = function (ms) {
        return ms ? new Date(ms).toLocaleString('de-DE', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr' : 'noch nie';
      };
      const zeile = function (titel, wann, fehler, hinweis) {
        return '<div class="docrow"><div class="grow"><strong>' + titel + '</strong>'
          + '<div class="unit-type">' + (fehler
              ? '<span style="color:var(--sperr)">' + esc(fehler) + '</span>'
              : 'zuletzt ' + esc(zeit(wann))) + (hinweis ? ' · ' + hinweis : '') + '</div></div></div>';
      };
      body = '<h2>Server-Sicherung</h2>'
        + '<div class="hint">Jede Nacht sichert der Server die komplette Datenbank: '
        + 'auf dem Server selbst (die letzten 14 Tage) und in deinem Google Drive im Ordner '
        + '„Vermietung – Sicherungen“ (die letzten 30 Tage). In der Drive-Kopie fehlen die '
        + 'Zugangsschlüssel für Todoist, Google, OpenAI und Claude — die bleiben nur auf dem Server.</div>';
      if (!si) {
        body += '<div class="docempty">Wird geladen …</div>';
      } else {
        body += '<div class="doclist">'
          + zeile('Auf dem Server', si.lokal, si.lokalFehler,
              si.dateien.length + (si.dateien.length === 1 ? ' Sicherung' : ' Sicherungen') + ' vorhanden')
          + zeile('In Google Drive', si.drive,
              si.googleVerbunden ? si.driveFehler : 'Erst das Postfach verbinden (Menü → Postfach), dann geht es auch in Drive.',
              '')
          + '</div>';
      }
      body += '<div class="modal-actions"><button class="primary" data-act="sicherung-jetzt"'
        + (sicherungLaeuftJetzt ? ' disabled' : '') + '>' + (sicherungLaeuftJetzt ? 'Sichert …' : 'Jetzt sichern') + '</button>'
        + '<div class="spacer"></div><button data-act="close">Schließen</button></div>';
    } else if (modal.kind === 'staende') {
      body = '<h2>Verlauf</h2>'
        + '<div class="hint">Der Server hebt die letzten fünfzig Stände auf. '
        + 'Etwas versehentlich gelöscht? Hier holst du es zurück.</div>';
      if (!staende.length) {
        body += '<div class="docempty">Noch keine gespeicherten Stände.</div>';
      } else {
        body += '<div class="doclist">' + staende.map(function (st) {
          return '<div class="docrow"><div class="grow"><strong>'
            + new Date(st.wann).toLocaleString('de-DE') + '</strong>'
            + '<div class="unit-type">von ' + esc(st.wer || 'unbekannt') + '</div></div>'
            + '<button class="tiny" data-act="verlauf-laden" data-id="' + st.id + '">Laden</button></div>';
        }).join('') + '</div>';
      }
      body += '<div class="modal-actions"><div class="spacer"></div>'
        + '<button data-act="close">Schließen</button></div>';
    } else {
      const o = modal.object;
      body = '<h2>' + (modal.isNew ? 'Objekt anlegen' : 'Objekt bearbeiten') + '</h2>'
        + f('Name', '<input type="text" id="m-oname" value="' + esc(o.name) + '" placeholder="z. B. Holzgasse 23">')
        + f('Ortsübliche Vergleichsmiete (€/m²)', '<input type="number" id="m-bench" step="0.01" value="'
            + (o.benchmark == null ? '' : o.benchmark) + '" placeholder="z. B. 12,50">')
        + f('Mietspiegel', '<input type="text" id="m-msname" value="' + esc(o.mietspiegel || '')
            + '" placeholder="Welcher Mietspiegel gilt?">')
        + '<div class="two">'
        + f('Link zum Mietspiegel', '<input type="url" id="m-msurl" value="' + esc(o.mietspiegelUrl || '')
            + '" placeholder="https://…">')
        + f('Gültig bis', '<input type="date" id="m-msbis" value="' + esc(o.mietspiegelBis || '') + '">')
        + '</div>'
        + f('Drive-Ordner für Belege', '<input type="text" id="m-ordner" value="' + esc(o.ordnerId || '')
            + '" placeholder="ID aus der Drive-Adresse">')
        + f('Notiz', '<textarea id="m-onote" rows="2">' + esc(o.note || '') + '</textarea>')
        + '<div class="modal-actions">'
        + (modal.isNew ? '' : '<button class="danger" data-act="delete-object">Löschen</button>')
        + '<div class="spacer"></div><button data-act="close">Abbrechen</button>'
        + '<button class="primary" data-act="save-object">Speichern</button></div>';
    }
    const breit = (modal.kind === 'strom' || modal.kind === 'konto' || modal.kind === 'wartung'
      || modal.kind === 'nk' || modal.kind === 'auszug') ? ' breit'
      : (modal.kind === 'aufgabe' ? ' mittel' : '');

    const titel = {
      unit: 'Einheit', object: 'Objekt', strom: 'Stromabrechnung', konto: 'Mietkonto',
      wartung: 'Prüfungen', aufgabe: 'Aufgabe', todoist: 'Todoist', zugaenge: 'Zugänge',
      sicherung: 'Daten sichern', serversicherung: 'Server-Sicherung', plan: 'Tagesplan', planeinst: 'Tagesplan', staende: 'Verlauf', menue: 'Menü', google: 'Postfach',
      schreiben: 'Schreiben', nk: 'Betriebskosten', auszug: 'Kontoauszug', beleg: 'Beleg ablegen',
      schnell: 'Aufgabe hinzufügen', suche: 'Suchen', absender: 'Einstellungen'
    }[modal.kind] || '';


    return '<div class="backdrop" data-act="backdrop"><div class="modal' + breit + '" data-fenster="' + modal.kind + '">'
      + '<div class="fx-leiste"><span>' + titel + '</span>'
      + '<button class="fx-reset" data-act="fenster-reset" title="Größe und Lage auf Standard zurücksetzen">Zurücksetzen</button>'
      + '<button class="fx-x" data-act="close" title="Schließen (Esc)">✕</button></div>'
      + '<div class="griff"></div>'
      + '<div class="fensterkopf"><button class="zurueck" data-act="close">‹ Zurück</button>'
      + '<span>' + titel + '</span><span class="kopf-platz"></span></div>'
      + '<div class="fensterinhalt">' + body + '</div>'
      + '<div class="fx-kante-r"></div><div class="fx-kante-u"></div><div class="fx-eck"></div>'
      + '</div></div>';
  }

  function f(l, c) { return '<div class="field"><label>' + l + '</label>' + c + '</div>'; }
  function sel(id, opts, val) {
    return '<select id="' + id + '">' + opts.map(function (o) {
      const v = Array.isArray(o) ? o[0] : o, t = Array.isArray(o) ? o[1] : o;
      return '<option value="' + v + '"' + (v === val ? ' selected' : '') + '>' + t + '</option>';
    }).join('') + '</select>';
  }

  // Die Zurück-Taste des Handys schließt das Fenster statt die Seite zu verlassen
  window.addEventListener('popstate', function () {
    if (modal) { modal = null; render(); }
  });

  // Nach unten wischen schließt das Fenster
  function wischen(bd) {
    const m = bd.querySelector('.modal');
    let start = null, weg = 0;
    m.addEventListener('touchstart', function (ev) {
      const inhalt = bd.querySelector('.fensterinhalt');
      if (inhalt && inhalt.scrollTop > 4) return;      // erst wenn oben angekommen
      start = ev.touches[0].clientY; weg = 0;
    }, { passive: true });
    m.addEventListener('touchmove', function (ev) {
      if (start === null) return;
      weg = ev.touches[0].clientY - start;
      if (weg > 0) m.style.transform = 'translateY(' + weg + 'px)';
    }, { passive: true });
    m.addEventListener('touchend', function () {
      if (start === null) return;
      m.style.transform = '';
      if (weg > 110) fensterZu();
      start = null;
    });
  }

  function fensterGeoeffnet() {
    try { history.pushState({ fenster: true }, ''); } catch (e) { /* egal */ }
  }

  function wire() {
    root.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        const act = el.getAttribute('data-act');
        if (act === 'backdrop' && ev.target !== el) return;
        if (el.tagName === 'A') return;
        ev.stopPropagation();
        handle(act, el);
      });
    });
    rgBinden();
    nkBinden();
    stammBinden();
    sucheBinden();
    // Stimme der Tagesmemo: Wahl merken und sofort kurz anhören
    const stimmwahl = root.querySelector('#memo-stimme');
    if (stimmwahl) {
      stimmwahl.addEventListener('change', function () {
        if (stimme.verbunden) {
          const gewaehlt = stimmwahl.value;
          api('stimme', { method: 'PUT', body: { stimme: gewaehlt } })
            .then(function (e) { stimme = e; memoProbe(); })
            .catch(function (fehler) { toast(fehler.message); });
          return;
        }
        memoStimmeMerken(stimmwahl.value);
        memoProbe();
      });
    }

    // Zeitachse entzerren: jeder Block so hoch wie sein Text, Überlappendes
    // rückt vollständig untereinander — kein Block verdeckt je einen anderen.
    (function () {
      const spalteEl = root.querySelector('.zspalte');
      if (!spalteEl) return;
      const bloecke = Array.from(spalteEl.querySelectorAll('.ztermin'))
        .sort(function (a, c) { return parseFloat(a.dataset.echt) - parseFloat(c.dataset.echt); });
      let unten = -9999;
      bloecke.forEach(function (block, i) {
        block.style.height = 'auto';
        const inhalt = block.scrollHeight + 2;                       // was der Text braucht
        const echt = parseFloat(block.dataset.echt);
        const oben = Math.max(echt, unten + 4);
        // So hoch wie die Dauer — aber nie weiter, als der Text braucht,
        // wenn dahinter schon der Nächste wartet: der soll auf seine Linie können.
        const echtesEnde = echt + parseFloat(block.dataset.hoch);
        let wunsch = echtesEnde - oben;
        const naechster = bloecke[i + 1];
        if (naechster) {
          wunsch = Math.min(wunsch, parseFloat(naechster.dataset.echt) - 4 - oben);
        }
        wunsch = Math.max(inhalt, wunsch);
        block.style.top = oben + 'px';
        block.style.height = wunsch + 'px';
        unten = oben + wunsch;
      });
      const achse = root.querySelector('.zeitachse');
      if (achse && unten + 10 > parseFloat(achse.style.height)) {
        achse.style.height = (unten + 10) + 'px';
      }
    })();

    // Zeitachse: Rollposition merken und beim Tageswechsel sinnvoll anfahren
    const rahmen = root.querySelector('.zeitrahmen');
    if (rahmen) {
      if (kalRolleTag === kalTag && kalRolle != null) {
        rahmen.scrollTop = kalRolle;
      } else {
        const HOEHE = KAL_HOEHE;
        let ziel = 7 * HOEHE;                                  // sonst: der Morgen
        const erster = rahmen.querySelector('.ztermin');
        if (kalTag === heuteISO()) {
          ziel = Math.max(0, (new Date().getHours() - 2) * HOEHE);   // heute: die aktuelle Stunde …
          // … aber frühere Termine des Tages mit zeigen, solange „jetzt“ noch ins Bild passt
          const frueh = erster ? Math.max(0, parseFloat(erster.style.top) - HOEHE) : ziel;
          if (frueh < ziel && ziel - frueh < rahmen.clientHeight - 2 * HOEHE) ziel = frueh;
        } else if (erster) {
          ziel = Math.max(0, parseFloat(erster.style.top) - HOEHE);  // sonst: der erste Termin
        }
        rahmen.scrollTop = ziel;
        kalRolleTag = kalTag; kalRolle = ziel;
      }
      rahmen.addEventListener('scroll', function () {
        kalRolle = rahmen.scrollTop; kalRolleTag = kalTag;
      }, { passive: true });
    }

    // Uhrzeit im Eingabekasten: Auswahl übernehmen und den Chip nachführen
    const zeitFeld = root.querySelector('#td-e-zeit');
    if (zeitFeld) {
      zeitFeld.addEventListener('change', function () {
        if (!tdEditor) return;
        tdEditorMerken();
        tdEditor.zeit = zeitFeld.value || '';
        if (tdEditor.zeit && !tdEditor.faellig) tdEditor.faellig = tdEditor.vorgabe || heuteISO();
        render();
      });
    }

    // Auftrag tippen statt sprechen
    const aFeld = root.querySelector('#a-text');
    if (aFeld) {
      aFeld.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault(); ev.stopPropagation();
        const text = aFeld.value.trim();
        if (text) { aFeld.value = ''; assistentSenden(text); }
      });
    }

    // Aufgaben wie in Todoist: Eingabekasten, Suche und Datumsfelder in den Menüs
    const eTitel = root.querySelector('#td-e-titel');
    if (eTitel) {
      eTitel.addEventListener('input', tdEditorLive);
      [eTitel, root.querySelector('#td-e-besch')].forEach(function (feld) {
        if (!feld) return;
        feld.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); tdEditorAbsenden(); }
          else if (ev.key === 'Escape') {
            ev.preventDefault(); ev.stopPropagation();
            if (tdMenue) { tdEditorMerken(); tdMenue = null; render(); return; }
            if (tdEditor && tdEditor.ort === 'schnell') modal = null;
            tdEditor = null; render();
          }
        });
      });
      const eProjekt = root.querySelector('#td-e-projekt');
      if (eProjekt) eProjekt.addEventListener('change', function () { tdEditorMerken(); tdEditor.sektion = ''; render(); });
    }
    const suche = root.querySelector('#td-suche');
    if (suche) {
      suche.addEventListener('input', function () { tdSuche = suche.value; tdSucheFokus = true; render(); });
      suche.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); tdSuche = ''; render(); }
      });
    }
    // Aufgaben aus der Liste in den Zeitplan ziehen (PC)
    root.querySelectorAll('[data-zieh]').forEach(function (el) {
      el.addEventListener('dragstart', function (ev) {
        ev.dataTransfer.setData('text/plain', 'aufgabe:' + el.getAttribute('data-zieh'));
        ev.dataTransfer.effectAllowed = 'move';
        root.classList.add('zieht');
      });
      el.addEventListener('dragend', function () { root.classList.remove('zieht'); });
    });
    const achseZiel = root.querySelector('.tagkarte .zeitachse');
    if (achseZiel) {
      let marke = null;
      const minuteAus = function (ev) {
        const r = achseZiel.getBoundingClientRect();
        const m = Math.round(((ev.clientY - r.top) / KAL_HOEHE * 60) / 15) * 15;
        return Math.max(0, Math.min(23 * 60 + 45, m));
      };
      const uhr = function (m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
      achseZiel.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        const m = minuteAus(ev);
        if (!marke) { marke = document.createElement('div'); marke.className = 'zmarke'; achseZiel.appendChild(marke); }
        marke.style.top = (m / 60 * KAL_HOEHE) + 'px';
        marke.textContent = uhr(m);
      });
      achseZiel.addEventListener('dragleave', function (ev) {
        if (marke && !achseZiel.contains(ev.relatedTarget)) { marke.remove(); marke = null; }
      });
      achseZiel.addEventListener('drop', function (ev) {
        ev.preventDefault();
        if (marke) { marke.remove(); marke = null; }
        root.classList.remove('zieht');
        const d = String(ev.dataTransfer.getData('text/plain') || '');
        if (d.indexOf('aufgabe:') !== 0) return;
        tdUhrzeitSetzen(d.slice(8), kalTag || heuteISO(), uhr(minuteAus(ev)));
      });
    }
    root.querySelectorAll('.td-m-zeit').forEach(function (feld) {
      feld.addEventListener('change', function () {
        if (feld.value) tdUhrzeitSetzen(feld.getAttribute('data-tid'), heuteISO(), feld.value);
      });
    });
    root.querySelectorAll('.td-m-datum').forEach(function (feld) {
      feld.addEventListener('change', function () {
        if (!feld.value) return;
        feld.setAttribute('data-datum', feld.value);
        handle(feld.getAttribute('data-ziel'), feld);
      });
    });

    root.querySelectorAll('tr.unitrow').forEach(function (tr) {
      tr.addEventListener('dblclick', function (ev) {
        if (ev.target.tagName === 'A' || ev.target.tagName === 'BUTTON') return;
        openUnit(tr.getAttribute('data-oid'), tr.getAttribute('data-uid'));
      });
    });

    const auszugFeld = root.querySelector('#auszug-datei');
    if (auszugFeld) {
      auszugFeld.addEventListener('change', function () {
        const datei = auszugFeld.files && auszugFeld.files[0];
        if (!datei) return;
        const leser = new FileReader();
        leser.onload = function () {
          try {
            const inhalt = String(leser.result);
            const buchungen = inhalt.trim().charAt(0) === '<'
              ? buchungenAusCamt(inhalt) : buchungenAusCsv(inhalt);
            if (!buchungen.length) { toast('Keine Eingänge erkannt'); return; }
            modal.zuordnung = buchungenZuordnen(buchungen);
            render();
          } catch (e) { toast('Die Datei ließ sich nicht lesen'); }
        };
        leser.readAsText(datei, 'utf-8');
      });
    }

    const box = root.querySelector('.modal');
    if (box) {
      box.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          if (tdMenue) { tdMenue = null; render(); return; }
          if (tdEditor && modal.kind === 'aufgabe') { tdEditor = null; render(); return; }
          modal = null; tdEditor = null; render(); return;
        }
        if (ev.key !== 'Enter') return;
        const t = ev.target;
        if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON') return;
        ev.preventDefault();
        if (t.id === 'td-e-titel' || t.id === 'td-e-besch') { tdEditorAbsenden(); return; }
        if (t.id === 'm-docname' || t.id === 'm-docurl') { addDoc(); return; }
        if (t.id === 't-kommentar') { kommentarSenden(); return; }
        if (t.id === 't-verlauf') { verlaufEintragen(); return; }
        if (modal.kind === 'aufgabe') { aufgabeSpeichern(); return; }
        if (modal.kind === 'schnell') { tdEditorAbsenden(); return; }
        if (modal.kind === 'interessent') { interessentSpeichern(); return; }
        if (modal.kind === 'unit') saveUnit();
        else if (modal.kind === 'object') saveObject();
      });
      if (!mobil) {
        const first = box.querySelector('input, select, textarea');
        if (first) first.focus();
      }
    }

    const q = root.querySelector('#q');
    if (q) q.addEventListener('input', function () {
      query = q.value;
      const pos = q.selectionStart;
      render();
      const q2 = root.querySelector('#q');
      if (q2) { q2.focus(); q2.setSelectionRange(pos, pos); }
    });
  }

  function springe(auswahl) {
    const el = root.querySelector(auswahl);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handle(act, el) {
    if (memoLaeuft && act !== 'memo-sprechen' && act.indexOf('zu-') === 0) memoStopp(true);
    if (act !== 'menue' && menueOffen) menueOffen = false;
    if (act !== 'fab' && fabOffen) fabOffen = false;
    const menueWar = tdMenue;
    if (act !== 'td-menue') tdMenue = null;
    if (act !== 'seite' && act !== 'theme' && seiteOffen) seiteOffen = false;
    if (act === 'toggle') {
      const id = el.getAttribute('data-id');
      open[id] = !open[id];
      render();
      if (open[id] && todoist.verbunden && !aufgaben[id]) {
        aufgabenLaden(id).then(function () { if (open[id]) render(); });
      }
    }
    else if (act === 'fab') { fabOffen = !fabOffen; render(); }
    else if (act === 'fab-aufgabe') { tdSchnell(); }
    else if (act === 'zu-heute' || act === 'zu-uebersicht') {
      ansicht = 'heute'; render(); window.scrollTo(0, 0);
    }
    else if (act === 'zu-objekte') {
      ansicht = 'objekte'; render(); window.scrollTo(0, 0);
    }
    else if (act === 'zu-aufgaben') {
      ansicht = 'aufgaben'; render(); window.scrollTo(0, 0);
      if (todoist.verbunden && alleAufgaben === null) alleLaden().then(function () { render(); });
    }
    // ---- Aufgaben wie in Todoist ----
    else if (act === 'td-frisch') {
      alleAufgaben = null; render();
      alleLaden().then(function () { render(); });
    }
    else if (act === 'td-ansicht') {
      tdAnsicht = el.getAttribute('data-a') || 'heute';
      tdEditor = null; tdSuche = '';
      tdMerken(); render();
      if (mobil) window.scrollTo(0, 0);
    }
    else if (act === 'td-klappen') {
      const k = el.getAttribute('data-k');
      if (tdZu[k]) delete tdZu[k]; else tdZu[k] = 1;
      tdMerken(); render();
    }
    else if (act === 'td-fertig') { tdFertig(el.getAttribute('data-tid'), el); }
    else if (act === 'suche') { sucheOeffnen(); }
    else if (act === 'such-treffer') { sucheSpringen(el); }
    else if (act === 'td-oeffnen') { tdOeffnen(el.getAttribute('data-tid')); }
    else if (act === 'td-menue') {
      const typ = el.getAttribute('data-typ'), tid = el.getAttribute('data-tid') || '';
      tdEditorMerken();
      tdMenue = (menueWar && menueWar.typ === typ && menueWar.tid === tid) ? null : { typ: typ, tid: tid };
      render();
    }
    else if (act === 'td-filter-projekt') { tdFilter.projekt = el.getAttribute('data-wert') || ''; render(); }
    else if (act === 'td-filter-label') {
      const l = el.getAttribute('data-wert') || '';
      tdFilter.label = tdFilter.label === l ? '' : l; render();
    }
    else if (act === 'td-gruppieren') {
      tdGruppiert = !tdGruppiert;
      try { window.localStorage.setItem('vermietung:td-gruppiert', tdGruppiert ? '1' : '0'); } catch (e) { /* egal */ }
      render();
    }
    else if (act === 'td-warten') { tdWartenSetzen(el.getAttribute('data-tid'), Number(el.getAttribute('data-tage')) || 3); }
    else if (act === 'td-warten-ende') { tdWartenEnde(el.getAttribute('data-tid')); }
    else if (act === 'td-uhrzeit') { tdUhrzeitSetzen(el.getAttribute('data-tid'), heuteISO(), el.getAttribute('data-zeit')); }
    else if (act === 't-verlauf') { verlaufEintragen(); }
    else if (act === 't-verlauf-diktat') { verlaufDiktieren(); }
    else if (act === 'td-setzen') { tdDatumSetzen(el.getAttribute('data-tid'), el.getAttribute('data-datum') || ''); }
    else if (act === 'td-prio') { tdPrioSetzen(el.getAttribute('data-tid'), Number(el.getAttribute('data-p')) || 1); }
    else if (act === 'td-verschieben') { tdVerschieben(el.getAttribute('data-tid'), el.getAttribute('data-projekt')); }
    else if (act === 'td-loeschen') { tdLoeschen(el.getAttribute('data-tid')); }
    else if (act === 'td-neuplanen') { tdNeuplanen(el.getAttribute('data-datum')); }
    else if (act === 'td-neu') {
      tdEditorOeffnen({
        ort: el.getAttribute('data-ort'), projektId: el.getAttribute('data-projekt'),
        sektion: el.getAttribute('data-sektion'), faellig: el.getAttribute('data-datum'), eltern: el.getAttribute('data-eltern')
      });
      render();
    }
    else if (act === 'td-e-abbruch') {
      if (tdEditor && tdEditor.ort === 'schnell') modal = null;
      tdEditor = null; render();
    }
    else if (act === 'td-e-ok') { tdEditorAbsenden(); }
    else if (act === 'td-e-datum') {
      tdEditorMerken();
      if (tdEditor) { tdEditor.faellig = el.getAttribute('data-datum') || ''; tdEditor.fest = true; }
      render();
    }
    else if (act === 'td-e-zeit-weg') {
      const zf = root.querySelector('#td-e-zeit');
      if (zf) zf.value = '';
      tdEditorMerken();
      if (tdEditor) tdEditor.zeit = '';
      render();
    }
    else if (act === 'td-e-prio') {
      tdEditorMerken();
      if (tdEditor) tdEditor.prio = Number(el.getAttribute('data-p')) || 1;
      render();
    }
    else if (act === 'td-spring') {
      const ziel = el.getAttribute('data-ziel');
      if (tdZu[ziel]) { delete tdZu[ziel]; tdMerken(); render(); }
      const z = document.getElementById(ziel);
      if (z) z.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    else if (act === 'td-suche-leer') { tdSuche = ''; render(); }
    else if (act === 'td-schnell') { tdSchnell(); }
    else if (act === 't-datum') {
      const feld = root.querySelector('#t-faellig');
      if (feld) feld.value = el.getAttribute('data-datum') || '';
    }
    else if (act === 't-prio') {
      const p = Number(el.getAttribute('data-p')) || 1;
      const feld = root.querySelector('#t-prio'); if (feld) feld.value = String(p);
      root.querySelectorAll('.td-f-feld .td-flagge').forEach(function (b) {
        b.classList.toggle('aktiv', Number(b.getAttribute('data-p')) === p);
      });
      const kopf = root.querySelector('#t-kopf'); if (kopf) kopf.className = 'td-f-titel td-zeile p' + p;
    }
    else if (act === 'memo-sprechen') { memoVorlesen(); }
    else if (act === 'kal-tag') {
      const iso = el.getAttribute('data-datum');
      if (kalSchiebt) { kalSchiebenAuf(iso); return; }
      kalTag = iso;
      render();
    }
    else if (act === 'kal-vor' || act === 'kal-zurueck') {
      const d = new Date(Number(kalTag.slice(0, 4)), Number(kalTag.slice(5, 7)) - 1, Number(kalTag.slice(8, 10)));
      d.setDate(d.getDate() + (act === 'kal-vor' ? 7 : -7));
      kalTag = kalIso(d); render();
    }
    else if (act === 'kal-heute') { kalTag = heuteISO(); render(); }
    else if (act === 'kal-abhaken') {
      const k = el.getAttribute('data-k');
      if (!data.kalErledigt) data.kalErledigt = {};
      if (data.kalErledigt[k]) delete data.kalErledigt[k];
      else data.kalErledigt[k] = heuteISO();
      // Älter als zwei Wochen braucht es nicht mehr
      const grenze = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      Object.keys(data.kalErledigt).forEach(function (x) { if (data.kalErledigt[x] < grenze) delete data.kalErledigt[x]; });
      save(); render();
    }
    else if (act === 'memo-alle') { memoAlle = !memoAlle; render(); }
    else if (act === 'kal-ganz') { kalGanzAuf = !kalGanzAuf; render(); }
    else if (act === 'kal-sprechen') { kalVorlesen(); }
    else if (act === 'memo-hoeren') { zuhoeren(); }
    else if (act === 'assistent-senden') {
      const text = val('a-text');
      if (!text) { toast('Bitte etwas eintippen'); return; }
      const feld = root.querySelector('#a-text');
      if (feld) feld.value = '';
      assistentSenden(text);
    }
    else if (act === 'assistent') { modal = { kind: 'assistent' }; render(); }
    else if (act === 'assistent-speichern') {
      const feld = root.querySelector('#as-token');
      const token = feld ? feld.value.trim() : '';
      if (!token) { toast('Bitte den Schlüssel einfügen'); return; }
      api('assistent', { method: 'PUT', body: { token: token } })
        .then(function (e) { assistent = e; toast('Gespeichert'); render(); })
        .catch(function (fehler) { toast(fehler.message); });
    }
    else if (act === 'assistent-trennen') {
      api('assistent', { method: 'PUT', body: { token: '' } })
        .then(function (e) { assistent = e; modal = null; toast('Schlüssel entfernt'); render(); })
        .catch(function (fehler) { toast(fehler.message); });
    }
    else if (act === 'stimme') { modal = { kind: 'stimme' }; render(); }
    else if (act === 'stimme-speichern') {
      const koerper = {};
      const feld = root.querySelector('#ki-token');
      if (feld && feld.value.trim()) koerper.token = feld.value.trim();
      if (root.querySelector('#ki-stimme')) koerper.stimme = val('ki-stimme');
      if (root.querySelector('#ki-anweisung')) koerper.anweisung = val('ki-anweisung');
      if (!stimme.verbunden && !koerper.token) { toast('Bitte den Schlüssel einfügen'); return; }
      api('stimme', { method: 'PUT', body: koerper })
        .then(function (e) {
          stimme = e;
          if (feld) feld.value = '';
          render();
          if (!e.verbunden) { toast('Nicht verbunden'); return; }
          // gleich ausprobieren, damit ein falscher Schlüssel sofort auffällt
          toast('Gespeichert — ich probiere die Stimme aus');
          tonFreischalten();
          memoSagen('Die Stimme ist eingerichtet.');
        })
        .catch(function (fehler) { toast(fehler.message); });
    }
    else if (act === 'stimme-probe') { memoProbe(); }
    else if (act === 'stimme-trennen') {
      api('stimme', { method: 'PUT', body: { token: '' } })
        .then(function (e) { stimme = e; modal = null; toast('Schlüssel entfernt'); render(); })
        .catch(function (fehler) { toast(fehler.message); });
    }
    else if (act === 'zu-mieten') {
      ansicht = 'mieten'; render(); window.scrollTo(0, 0);
    }
    else if (act === 'zu-interessenten') {
      ansicht = 'interessenten'; render(); window.scrollTo(0, 0);
    }
    else if (act === 'zu-post') {
      ansicht = 'post'; verstecktOffen = false; render(); window.scrollTo(0, 0);
    }
    else if (act === 'zu-rechnungen') {
      ansicht = 'rechnungen'; render(); window.scrollTo(0, 0);
      if (!rg) rgLaden();
    }
    else if (act === 'rg-tab') {
      rgTab = el.getAttribute('data-tab') || 'as';
      rgFormOffen = false; nkFormOffen = false;
      if (rgTab !== 'nk' && (!rgForm || rgArt(rgForm) !== rgTab)) rgNeu(rgTab);
      render(); window.scrollTo(0, 0);
    }
    else if (act === 'nk-stamm-speichern') { nkStammSpeichern(); }
    else if (act === 'nk-vorschau') { nkVorschau(); }
    else if (act === 'nk-speichern') { nkSpeichern(); }
    else if (act === 'nk-neu') { nkNeu(); nkFormOffen = true; render(); window.scrollTo(0, 0); }
    else if (act === 'nk-zu') { nkFormOffen = false; render(); }
    else if (act === 'rg-zu') { rgFormOffen = false; render(); }
    else if (act === 'absender') { absenderOeffnen(el.getAttribute('data-art')); }
    else if (act === 'absender-rg' || act === 'absender-nk') { seiteOffen = false; absenderOeffnen(act.slice(9)); }
    else if (act === 'nk-laden') { nkAusListe(el.getAttribute('data-id')); }
    else if (act === 'nk-loeschen') { rgLoeschen(el.getAttribute('data-id'), 'nk'); }
    else if (act === 'nk-posten-neu') { nkForm.posten.push({ text: '', betrag: '' }); render(); }
    else if (act === 'nk-posten-weg') { nkForm.posten.splice(Number(el.getAttribute('data-i')), 1); render(); }
    else if (act === 'nk-guthaben') { nkForm.guthabenWie = el.getAttribute('data-w'); render(); }
    else if (act === 'rg-stamm-speichern') { rgStammSpeichern(); }
    else if (act === 'rg-vorschau') { rgVorschau(); }
    else if (act === 'rg-speichern') { rgSpeichern(); }
    else if (act === 'rg-neu') { rgNeu(el.getAttribute('data-art') || rgTab); rgFormOffen = true; render(); window.scrollTo(0, 0); }
    else if (act === 'rg-folgejahr') {
      const e = rg && rg.liste.find(function (x) { return String(x.id) === el.getAttribute('data-id'); });
      if (e) { rgFolgejahr(e); rgFormOffen = true; toast('Neue Rechnung vorbereitet — nur noch den neuen Zählerstand eintragen'); render(); window.scrollTo(0, 0); }
    }
    else if (act === 'rg-laden') { rgAusListe(el.getAttribute('data-id')); }
    else if (act === 'rg-loeschen') { rgLoeschen(el.getAttribute('data-id')); }
    else if (act === 'seite') { seiteOffen = true; render(); }
    else if (act === 'seite-zu') { seiteOffen = false; render(); }
    else if (act === 'menue') { menueOffen = !menueOffen; render(); }
    else if (act === 'clear-q') { query = ''; render(); }
    else if (act === 'reiter') {
      const id = el.getAttribute('data-id');
      reiter[id] = el.getAttribute('data-r');
      render();
      if (reiter[id] === 'aufgaben' && todoist.verbunden && !aufgaben[id]) {
        aufgabenLaden(id).then(function () { render(); });
      }
    }
    else if (act === 'add-object') { modal = { kind: 'object', isNew: true, object: { id: 'o' + uid(), name: '', note: '', units: [] } }; render(); }
    else if (act === 'edit-object') { modal = { kind: 'object', isNew: false, object: findObj(el.getAttribute('data-id')) }; render(); }
    else if (act === 'add-unit') { modal = { kind: 'unit', isNew: true, oid: el.getAttribute('data-id'), unit: u({}) }; render(); }
    else if (act === 'edit-unit') { openUnit(el.getAttribute('data-oid'), el.getAttribute('data-uid')); }
    else if (act === 'status') {
      const o = findObj(el.getAttribute('data-oid'));
      const x = o.units.find(function (z) { return z.id === el.getAttribute('data-uid'); });
      const folge = { vermietet: 'frei', frei: 'gesperrt', gesperrt: 'unbekannt', unbekannt: 'vermietet' };
      x.status = folge[x.status] || 'vermietet';
      save();
      render();
    }
    else if (act === 'close' || act === 'backdrop') { fensterZu(); }
    else if (act === 'fenster-reset') { fensterZuruecksetzen(); }
    else if (act === 'save-unit') { saveUnit(); }
    else if (act === 'save-object') { saveObject(); }
    else if (act === 'add-doc') { addDoc(); }
    else if (act === 'del-doc') { captureUnit(); modal.unit.docs.splice(Number(el.getAttribute('data-i')), 1); render(); }
    else if (act === 'delete-unit') {
      const o = findObj(modal.oid);
      o.units = o.units.filter(function (z) { return z.id !== modal.unit.id; });
      modal = null; save('Einheit gelöscht'); render();
    }
    else if (act === 'delete-object') {
      data.objects = data.objects.filter(function (z) { return z.id !== modal.object.id; });
      modal = null; save('Objekt gelöscht'); render();
    }
    else if (act === 'export') { exportData(); }
    else if (act === 'strom') { modal = { kind: 'strom', oid: el.getAttribute('data-id') }; render(); }
    else if (act === 'pv-rechnen') { pvSpeichern(); }
    else if (act === 'pv-text') { pvText(el.getAttribute('data-uid')); }
    else if (act === 'todoist') {
      modal = { kind: 'todoist' }; render();
      todoistLaden().then(function () { if (modal && modal.kind === 'todoist') render(); });
    }
    else if (act === 'td-speichern') {
      const koerper = { zuordnung: {} };
      const t = root.querySelector('#td-token');
      if (t && t.value.trim()) koerper.token = t.value.trim();
      data.objects.forEach(function (o) {
        const sel = root.querySelector('#td-' + o.id);
        if (sel) koerper.zuordnung[o.id] = sel.value;
      });
      api('todoist', { method: 'PUT', body: koerper })
        .then(function () { return todoistLaden(); })
        .then(function () { toast('Gespeichert'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'td-senden') { todoistSenden(); }
    else if (act === 'aufgabe-neu') { aufgabeAnlegen(el.getAttribute('data-id')); }
    else if (act === 'woche-fertig') { wocheErledigt(el.getAttribute('data-tid')); }
    else if (act === 'post-alle') { postAlle = !postAlle; render(); }
    else if (act === 'post-frisch') {
      postFrisch = true; postListe = null; render();
      postLaden().then(function () { toast('Aktualisiert'); render(); });
    }
    else if (act === 'post-modus') {
      postModus = el.getAttribute('data-m');
      postListe = null; render();
      postLaden().then(function () { render(); });
    }
    else if (act === 'post-tage') {
      postTage = Number(el.getAttribute('data-t'));
      postListe = null; render();
      postLaden().then(function () { render(); });
    }
    else if (act === 'post-weg') {
      const alleW = (postListe || []).concat((postInfo && postInfo.rest) || []);
      const m = alleW.find(function (z) { return z.id === el.getAttribute('data-id'); });
      if (!m) return;
      api('post/ausblenden', { method: 'PUT', body: { id: m.id, betreff: m.betreff, von: m.von, wann: m.wann } })
        .then(function () {
          if (postListe) postListe = postListe.filter(function (z) { return z.id !== m.id; });
          if (postInfo && postInfo.rest) postInfo.rest = postInfo.rest.filter(function (z) { return z.id !== m.id; });
          if (postInfo) {
            postInfo.versteckt = postInfo.versteckt || [];
            postInfo.versteckt.push({ id: m.id, betreff: m.betreff, von: m.von, wann: m.wann });
          }
          toast('Ausgeblendet — unten holst du sie bei Bedarf zurück');
          render();
        })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'post-zurueck') {
      api('post/einblenden', { method: 'PUT', body: { id: el.getAttribute('data-id') } })
        .then(function () { postListe = null; render(); return postLaden(); })
        .then(function () { toast('Wieder dabei'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'post-versteckt') { verstecktOffen = !verstecktOffen; render(); }
    else if (act === 'post-oeffnen') {
      const alle = (postListe || []).concat((postInfo && postInfo.rest) || []);
      const m = alle.find(function (z) { return z.id === el.getAttribute('data-id'); });
      if (m) window.open(m.url, '_blank', 'noopener');
    }
    else if (act === 'post-aufgabe') {
      const alle2 = (postListe || []).concat((postInfo && postInfo.rest) || []);
      const m = alle2.find(function (z) { return z.id === el.getAttribute('data-id'); });
      if (!m) return;
      const o = m.objekt ? data.objects.find(function (z) { return z.name === m.objekt; }) : null;
      api('todoist/aufgabe', {
        method: 'POST',
        body: {
          inhalt: m.betreff,
          beschreibung: 'Aus Mail von ' + m.von + '\n' + m.url,
          projektId: (o && todoist.zuordnung) ? (todoist.zuordnung[o.id] || '') : ''
        }
      }).then(function () { return wocheLaden(); })
        .then(function () { toast('Als Aufgabe angelegt'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'post-belege') {
      const alle3 = (postListe || []).concat((postInfo && postInfo.rest) || []);
      const m = alle3.find(function (z) { return z.id === el.getAttribute('data-id'); });
      if (!m) return;
      modal = { kind: 'beleg', mail: m, anhaenge: null };
      render();
      api('post/' + encodeURIComponent(m.id) + '/anhaenge')
        .then(function (a) { modal.anhaenge = a; render(); })
        .catch(function (e) { modal.anhaenge = []; toast(e.message); render(); });
    }
    else if (act === 'beleg-ablegen') {
      const a = modal.anhaenge[Number(el.getAttribute('data-i'))];
      const ziel = val('beleg-ziel');
      const datum = modal.mail.wann ? new Date(modal.mail.wann).toISOString().slice(0, 10) : '';
      api('post/' + encodeURIComponent(modal.mail.id) + '/ablegen', {
        method: 'POST',
        body: { anhangId: a.id, name: (datum ? datum + ' ' : '') + a.name, ordnerId: ziel }
      }).then(function (r) {
        toast('In Drive abgelegt');
        window.open(r.url, '_blank', 'noopener');
      }).catch(function (e) { toast(e.message); });
    }
    else if (act === 'auszug') { modal = { kind: 'auszug' }; render(); }
    else if (act === 'auszug-buchen') {
      const z = (modal.zuordnung || []).filter(function (e) { return e.einheit && e.monat; });
      const summen = {};
      z.forEach(function (e) {
        const k = e.einheit.id + '|' + e.monat;
        summen[k] = (summen[k] || 0) + e.buchung.betrag;
      });
      Object.keys(summen).forEach(function (k) {
        const teile = k.split('|');
        data.objects.forEach(function (o) {
          o.units.forEach(function (x) {
            if (x.id !== teile[0]) return;
            if (!x.zahlungen) x.zahlungen = {};
            x.zahlungen[teile[1]] = Math.round(summen[k] * 100) / 100;
          });
        });
      });
      modal = null;
      save(Object.keys(summen).length + ' Monatszahlungen übernommen');
      render();
    }
    else if (act === 'nk') { modal = { kind: 'nk', oid: el.getAttribute('data-id') }; render(); }
    else if (act === 'nk-vorlage') {
      const o = findObj(modal.oid);
      o.nk = { jahr: new Date().getFullYear() - 1,
        posten: NK_VORLAGE.map(function (v) { return { name: v.name, betrag: null, schluessel: v.schluessel }; }) };
      save(); render();
    }
    else if (act === 'nk-zeile-neu') { nkLesen(); findObj(modal.oid).nk.posten.push({ name: '', betrag: null, schluessel: 'flaeche' }); render(); }
    else if (act === 'nk-weg') { nkLesen(); findObj(modal.oid).nk.posten.splice(Number(el.getAttribute('data-i')), 1); save(); render(); }
    else if (act === 'nk-rechnen') { nkLesen(); save('Berechnet'); render(); }
    else if (act === 'nk-text') {
      const o = findObj(modal.oid);
      const r = nkRechnung(o).find(function (z) { return z.unit.id === el.getAttribute('data-uid'); });
      if (!r) return;
      const t = nkText(o, r);
      navigator.clipboard.writeText(t).then(function () { toast('Abrechnung kopiert'); })
        .catch(function () { kopierDialog(t); });
    }
    else if (act === 'schreiben') {
      modal = { kind: 'schreiben', oid: el.getAttribute('data-oid'), uid: el.getAttribute('data-uid'), art: 'erhoehung' };
      render();
    }
    else if (act === 'schreiben-art') { modal.art = el.getAttribute('data-a'); render(); }
    else if (act === 'brief-kopieren') {
      const feld = root.querySelector('#brief');
      feld.select(); feld.setSelectionRange(0, 999999);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (ok) toast('Kopiert — jetzt in Word einfügen');
      else navigator.clipboard.writeText(feld.value).then(function () { toast('Kopiert'); })
        .catch(function () { toast('Markiert — Strg+C'); });
    }
    else if (act === 'brief-drucken') {
      const feld = root.querySelector('#brief');
      const w = window.open('', '_blank');
      if (!w) { toast('Der Browser hat das Fenster blockiert'); return; }
      w.document.write('<pre style="font-family:Georgia,serif;font-size:12pt;line-height:1.6;'
        + 'white-space:pre-wrap;padding:25mm 20mm">' + feld.value.replace(/[&<>]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
          }) + '</pre>');
      w.document.close();
      w.focus();
      setTimeout(function () { w.print(); }, 250);
    }
    else if (act === 'google') {
      modal = { kind: 'google' }; render();
      api('post/filter').then(function (f) { postFilter = f; if (modal && modal.kind === 'google') render(); })
        .catch(function () { /* egal */ });
    }
    else if (act === 'pf-suchen') {
      const q = val('pf-suche');
      if (!q) { toast('Bitte einen Suchbegriff eingeben'); return; }
      api('post/suche?q=' + encodeURIComponent(q))
        .then(function (r) { modal.suche = r; render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'pf-speichern') {
      api('post/filter', { method: 'PUT', body: { stichworte: val('pf-worte'), ausschluss: val('pf-aus') } })
        .then(function () { postFilter = { stichworte: val('pf-worte'), ausschluss: val('pf-aus') }; return postLaden(); })
        .then(function () { toast('Filter gespeichert'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'google-speichern') {
      api('google', { method: 'PUT', body: { clientId: val('g-id'), clientSecret: val('g-secret') } })
        .then(function () { return googleLaden(); })
        .then(function () { toast('Gespeichert'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'google-trennen') {
      api('google', { method: 'DELETE' })
        .then(function () { return googleLaden(); })
        .then(function () { postListe = []; modal = null; toast('Getrennt'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'gkal') {
      modal = { kind: 'gkal' }; render();
      gkalStatusLaden().then(function () { if (modal && modal.kind === 'gkal') render(); });
    }
    else if (act === 'gkal-info') { modal = { kind: 'gkal-info', id: el.getAttribute('data-id') }; render(); }
    else if (act === 'gkal-speichern') {
      const u = val('gk-url');
      if (!u) { toast('Bitte die iCal-Adresse einfügen'); return; }
      toast('Prüfe die Adresse …');
      api('gkal', { method: 'PUT', body: { url: u } })
        .then(function (r) {
          gkal = { eingerichtet: true };
          gkalBereich = ''; gkalListe = [];
          modal = null;
          toast('Verbunden — ' + (r && r.anzahl != null ? r.anzahl : 0) + ' Einträge gefunden');
          render();
        })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'gkal-frisch') {
      gkalFrisch = true; gkalBereich = '';
      modal = null; toast('Kalender wird neu geladen'); render();
    }
    else if (act === 'gkal-trennen') {
      api('gkal', { method: 'PUT', body: { url: '' } })
        .then(function () {
          gkal = { eingerichtet: false }; gkalListe = []; gkalBereich = '';
          modal = null; toast('Verbindung gelöst'); render();
        })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'aufgabe-oeffnen') { tdOeffnen(el.getAttribute('data-tid')); }
    else if (act === 't-speichern') { aufgabeSpeichern(); }
    else if (act === 't-fertig') { tdFertig(modal.aufgabe.id, el); }
    else if (act === 't-loeschen') { aufgabeLoeschen(); }
    else if (act === 't-kommentar') { kommentarSenden(); }
    else if (act === 'aufgabe-fertig') { tdFertig(el.getAttribute('data-tid'), el); }
    else if (act === 'td-trennen') {
      api('todoist', { method: 'PUT', body: { token: '' } })
        .then(function () { return todoistLaden(); })
        .then(function () { modal = null; toast('Verbindung gelöst'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'konto') { modal = { kind: 'konto', oid: el.getAttribute('data-id') }; render(); }
    else if (act === 'konto-speichern') { kontoSpeichern(); }
    else if (act === 'wartung') { modal = { kind: 'wartung', oid: el.getAttribute('data-id') }; render(); }
    else if (act === 'pruef-vorlage') {
      const o = findObj(modal.oid);
      o.pruefungen = PRUEF_VORLAGE.map(function (v) { return { name: v.name, intervall: v.intervall, letzte: '' }; });
      save(); render();
    }
    else if (act === 'pruef-neu') {
      pruefLesen();
      findObj(modal.oid).pruefungen.push({ name: '', intervall: 12, letzte: '' });
      render();
    }
    else if (act === 'pruef-weg') {
      pruefLesen();
      findObj(modal.oid).pruefungen.splice(Number(el.getAttribute('data-i')), 1);
      save(); render();
    }
    else if (act === 'pruef-speichern') { pruefLesen(); save('Gespeichert'); render(); }
    else if (act === 'datei-sichern') { alsDateiSichern(); }
    else if (act === 'json-kopieren') {
      textKopieren();
      try { window.localStorage.setItem(SICHERUNG_ZEIT, String(Date.now())); } catch (e) { /* egal */ }
    }
    else if (act === 'json-download') {
      herunterladenVersuchen();
      try { window.localStorage.setItem(SICHERUNG_ZEIT, String(Date.now())); } catch (e) { /* egal */ }
    }
    else if (act === 'json-einlesen') { textEinlesen(); }
    else if (act === 'datei-laden') { ausDateiLaden(); }
    else if (act === 'menue') { modal = { kind: 'menue' }; render(); }
    else if (act === 'staende') {
      modal = { kind: 'staende' }; render();
      verlaufHolen().then(function () { if (modal && modal.kind === 'staende') render(); });
    }
    else if (act === 'verlauf-laden') { verlaufLaden(el.getAttribute('data-id')); }
    else if (act === 'plan-zeigen') {
      modal = { kind: 'plan' }; render();
      planLaden().then(function () { if (modal && modal.kind === 'plan') render(); });
    }
    else if (act === 'plan-uebernehmen') {
      if (planLaeuft) return;
      const auto = root.querySelector('#plan-auto');
      const automatisch = !!(auto && auto.checked);
      planLaeuft = true; render();
      (automatisch ? api('plan/einstellungen', { method: 'PUT', body: { automatisch: true } }) : Promise.resolve())
        .then(function () { return api('plan', { method: 'POST', body: { datum: planInfo && planInfo.datum } }); })
        .then(function (r) {
          modal = null;
          planLaeuft = false;
          return planNachAenderung('Geplant: ' + r.geaendert + (r.geaendert === 1 ? ' Aufgabe' : ' Aufgaben') + ' eingetragen'
            + (r.fehler.length ? ' — ' + r.fehler.length + ' nicht (' + r.fehler[0].fehler + ')' : ''));
        })
        .catch(function (e) { planLaeuft = false; toast(e.message); render(); });
    }
    else if (act === 'plan-zurueck') {
      if (planLaeuft) return;
      dialog({ titel: 'Planung zurücknehmen?', text: 'Alle Aufgaben bekommen wieder ihr altes Datum.',
        knoepfe: [{ label: 'Abbrechen', wert: false }, { label: 'Zurücknehmen', wert: true, art: 'primaer' }] })
        .then(function (w) {
          if (!w.wert) return;
          planLaeuft = true; render();
          return api('plan/rueckgaengig', { method: 'POST', body: {} })
            .then(function (r) {
              planLaeuft = false;
              return planNachAenderung('Zurückgenommen: ' + r.zurueck + (r.zurueck === 1 ? ' Aufgabe' : ' Aufgaben'));
            });
        })
        .catch(function (e) { planLaeuft = false; fehlerToast(e.message); render(); });
    }
    else if (act === 'plan-einst') {
      modal = { kind: 'planeinst' }; render();
      if (!planEinst) api('plan/einstellungen').then(function (e) { planEinst = e; if (modal && modal.kind === 'planeinst') render(); });
    }
    else if (act === 'plan-einst-speichern') {
      const wert = function (id) { const x = root.querySelector('#' + id); return x ? x.value : ''; };
      const tage = Array.prototype.slice.call(root.querySelectorAll('.pe-tag'))
        .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); });
      if (!tage.length) { toast('Mindestens ein Arbeitstag'); return; }
      api('plan/einstellungen', { method: 'PUT', body: {
        start: wert('pe-start'), ende: wert('pe-ende'), pauseVon: wert('pe-pvon'), pauseBis: wert('pe-pbis'),
        maxMinuten: Math.round(Number(wert('pe-max')) * 60), puffer: Number(wert('pe-puffer')),
        standardDauer: Number(wert('pe-dauer')), arbeitstage: tage,
        automatisch: !!(root.querySelector('#pe-auto') || {}).checked,
        ohneDatum: !!(root.querySelector('#pe-ohne') || {}).checked
      } })
        .then(function (e) { planEinst = e; modal = null; return planNachAenderung('Tagesplan eingestellt'); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'server-sicherung') {
      modal = { kind: 'serversicherung' }; render();
      api('sicherung').then(function (i) { sicherungInfo = i; if (modal && modal.kind === 'serversicherung') render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'sicherung-jetzt') {
      if (sicherungLaeuftJetzt) return;
      sicherungLaeuftJetzt = true; render();
      api('sicherung', { method: 'POST' })
        .then(function (e) {
          toast(e.driveFehler || e.lokalFehler ? 'Sicherung mit Problem — siehe Hinweis' : 'Gesichert');
          return api('sicherung');
        })
        .then(function (i) { sicherungInfo = i; })
        .catch(function (e) { toast(e.message); })
        .then(function () { sicherungLaeuftJetzt = false; if (modal && modal.kind === 'serversicherung') render(); });
    }
    else if (act === 'zugaenge') {
      modal = { kind: 'zugaenge' }; render();
      nutzerListeHolen().then(function () { if (modal && modal.kind === 'zugaenge') render(); });
    }
    else if (act === 'abmelden') { modal = null; abmelden(); }
    else if (act === 'nutzer-neu') {
      const name = val('n-name'), pw = val('n-pw');
      if (!name) { toast('Benutzername fehlt'); return; }
      if (pw.length < 8) { toast('Mindestens acht Zeichen'); return; }
      nutzerAnlegen(name, pw);
    }
    else if (act === 'nutzer-weg') { nutzerLoeschen(el.getAttribute('data-name')); }
    else if (act === 'nutzer-pw') {
      const wer = el.getAttribute('data-name');
      dialog({ titel: 'Neues Passwort für ' + wer, text: 'Mindestens acht Zeichen. ' + wer + ' wird dabei überall abgemeldet.',
        feld: { typ: 'password', platzhalter: 'Neues Passwort' },
        knoepfe: [{ label: 'Abbrechen', wert: false }, { label: 'Ändern', wert: true, art: 'primaer' }] })
        .then(function (w) {
          if (!w.wert) return;
          if ((w.eingabe || '').length < 8) { fehlerToast('Mindestens acht Zeichen'); return; }
          return api('users/' + encodeURIComponent(wer) + '/passwort', { method: 'PUT', body: { passwort: w.eingabe } })
            .then(function () { toast('Passwort für ' + wer + ' geändert'); });
        })
        .catch(function (e) { fehlerToast(e.message); });
    }
    else if (act === 'pw-aendern') {
      // Passwörter ungekürzt nehmen — Leerzeichen am Rand zählen mit
      const roh = function (id) { const f = root.querySelector('#' + id); return f ? f.value : ''; };
      const alt = roh('pw-alt'), neu = roh('pw-neu');
      if (neu.length < 8) { toast('Mindestens acht Zeichen'); return; }
      api('passwort', { method: 'POST', body: { alt: alt, neu: neu } })
        .then(function () { toast('Passwort geändert'); modal = null; render(); })
        .catch(function (e) { toast(e.message); });
    }


    else if (act === 'miete-monat') {
      mietVersatz = Math.max(-11, Math.min(0, mietVersatz + Number(el.getAttribute('data-d'))));
      render();
    }
    else if (act === 'miete-buchen') {
      const o = findObj(el.getAttribute('data-oid'));
      const x = o && o.units.find(function (z) { return z.id === el.getAttribute('data-uid'); });
      if (!x) return;
      if (!x.zahlungen) x.zahlungen = {};
      x.zahlungen[el.getAttribute('data-m')] = Math.round(soll(x) * 100) / 100;
      save(x.name + ': Miete erfasst');
      render();
    }
    else if (act === 'miete-alle') {
      const schl = el.getAttribute('data-m');
      let gebucht = 0;
      data.objects.forEach(function (o) {
        o.units.forEach(function (x) {
          if (x.status !== 'vermietet' || !soll(x)) return;
          const g = (x.zahlungen && x.zahlungen[schl] != null) ? n(x.zahlungen[schl]) : null;
          if (g != null && g >= soll(x) - 0.005) return;
          if (!x.zahlungen) x.zahlungen = {};
          x.zahlungen[schl] = Math.round(soll(x) * 100) / 100;
          gebucht++;
        });
      });
      if (!gebucht) { toast('Nichts offen'); return; }
      save(gebucht + ' Mieten als erhalten gebucht');
      render();
    }
    else if (act === 'interessent-fuer') {
      modal = { kind: 'interessent', isNew: true, i: interessentNeu({ einheitId: el.getAttribute('data-uid') }) };
      render();
    }
    else if (act === 'interessent-neu') {
      modal = { kind: 'interessent', isNew: true, i: interessentNeu({}) };
      render();
    }
    else if (act === 'interessent-oeffnen') {
      const inter = interessentVon(el.getAttribute('data-id'));
      if (!inter) return;
      modal = { kind: 'interessent', isNew: false, i: inter };
      render();
    }
    else if (act === 'interessent-weiter') {
      const inter = interessentVon(el.getAttribute('data-id'));
      if (!inter || !IFOLGE[inter.status]) return;
      inter.status = IFOLGE[inter.status];
      save((inter.name || 'Interessent') + ' → ' + istatusName(inter.status));
      render();
    }
    else if (act === 'interessent-speichern') { interessentSpeichern(); }
    else if (act === 'interessent-loeschen') {
      data.interessenten = data.interessenten.filter(function (z) { return z.id !== modal.i.id; });
      modal = null; save('Interessent entfernt'); render();
    }
    else if (act === 'interessent-termin-aufgabe') { interessentAufgabe(); }
    else if (act === 'interessent-absagen') { absagenOffen = !absagenOffen; render(); }
    else if (act === 'post-interessent') {
      const alleP = (postListe || []).concat((postInfo && postInfo.rest) || []);
      const m = alleP.find(function (z) { return z.id === el.getAttribute('data-id'); });
      if (!m) return;
      let name = m.von.replace(/<.*>/, '').replace(/"/g, '').trim();
      const mail = (m.von.match(/<([^>]+)>/) || [])[1] || (name.indexOf('@') !== -1 ? name : '');
      if (name.indexOf('@') !== -1) name = '';
      let eid = '';
      if (m.objekt) {
        const o = data.objects.find(function (z) { return z.name === m.objekt; });
        if (o && m.einheit) {
          const x = o.units.find(function (z) { return z.name === m.einheit; });
          if (x) eid = x.id;
        }
      }
      modal = {
        kind: 'interessent', isNew: true,
        i: interessentNeu({ name: name, kontakt: mail, einheitId: eid, quelle: 'Anfrage per Mail: ' + m.betreff })
      };
      render();
    }
    else if (act === 'push') {
      modal = { kind: 'push' };
      pushGeraete = null; pushFehler = null;
      render();
      pushModalLaden();
    }
    else if (act === 'push-an') { pushAn(); }
    else if (act === 'push-aus') { pushAus(); }
    else if (act === 'push-test') {
      api('push/test', { method: 'POST' })
        .then(function () { toast('Probemitteilung unterwegs'); })
        .catch(function (e) { pushFehler = e.message; render(); });
    }
    else if (act === 'push-zeit') {
      api('push/einstellungen', {
        method: 'PUT',
        body: {
          zeit: val('p-zeit'),
          morgen: val('p-morgen') !== 'aus',
          termine: val('p-termine') !== 'aus',
          anfragen: val('p-anfragen') !== 'aus',
          bloecke: val('p-bloecke') !== 'aus',
          abends: val('p-abends') !== 'aus',
          abendZeit: val('p-abendzeit')
        }
      })
        .then(function (e) { pushEinst = e; toast('Einstellungen übernommen'); render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'push-geraet-weg') {
      api('push/geraete/' + el.getAttribute('data-id'), { method: 'DELETE' })
        .then(function () { return api('push/geraete'); })
        .then(function (g) { pushGeraete = g; render(); })
        .catch(function (e) { toast(e.message); });
    }
    else if (act === 'theme') {
      themeWahl = { auto: 'light', light: 'dark', dark: 'auto' }[themeWahl];
      themeAnwenden();
      try {
        if (themeWahl === 'auto') window.localStorage.removeItem('vermietung:theme');
        else window.localStorage.setItem('vermietung:theme', themeWahl);
      } catch (e) { /* egal */ }
      render();
    }
  }

  function openUnit(oid, uid) {
    const o = findObj(oid);
    if (!o) return;
    const x = o.units.find(function (z) { return z.id === uid; });
    if (!x) return;
    modal = { kind: 'unit', isNew: false, oid: o.id, unit: x };
    render();
  }

  function interessentLesen() {
    const inter = modal.i;
    inter.name = val('i-name');
    inter.kontakt = val('i-kontakt');
    inter.einheitId = val('i-einheit');
    inter.status = val('i-status') || inter.status || 'neu';
    inter.termin = val('i-termin');
    const notiz = root.querySelector('#i-notiz');
    if (notiz) inter.notiz = notiz.value.trim();
  }
  function interessentSpeichern() {
    interessentLesen();
    const inter = modal.i;
    if (!inter.name) { toast('Bitte einen Namen eintragen'); return; }
    if (modal.isNew) data.interessenten.push(inter);
    const zusage = inter.status === 'zusage';
    modal = null;
    save(zusage ? 'Zusage — die Einheit dann auf „Vermietet" stellen' : 'Gespeichert');
    render();
  }
  function interessentAufgabe() {
    interessentLesen();
    const inter = modal.i;
    if (!inter.termin) { toast('Erst einen Termin eintragen'); return; }
    const info = einheitInfo(inter.einheitId);
    const zeit = inter.termin.length > 10 ? inter.termin.slice(11, 16) + ' Uhr — ' : '';
    api('todoist/aufgabe', {
      method: 'POST',
      body: {
        inhalt: 'Besichtigung ' + zeit + (inter.name || 'Interessent') + (info ? ' · ' + info.x.name : ''),
        beschreibung: (inter.kontakt ? inter.kontakt + '\n' : '') + (inter.notiz || ''),
        projektId: (info && todoist.zuordnung) ? (todoist.zuordnung[info.o.id] || '') : '',
        faellig: inter.termin.slice(0, 10)
      }
    }).then(function () { return wocheLaden(); })
      .then(function () { toast('Termin steht in Todoist'); render(); })
      .catch(function (e) { toast(e.message); });
  }

  function kontoSpeichern() {
    const o = findObj(modal.oid);
    const monate = letzteMonate(6);
    o.units.forEach(function (x) {
      monate.forEach(function (m) {
        const el = root.querySelector('#k-' + x.id + '-' + m.schluessel);
        if (!el) return;
        if (!x.zahlungen) x.zahlungen = {};
        if (el.value.trim() === '') delete x.zahlungen[m.schluessel];
        else x.zahlungen[m.schluessel] = Number(el.value);
      });
    });
    save('Gespeichert');
    render();
  }

  function nkLesen() {
    const o = findObj(modal.oid);
    if (!o.nk) o.nk = { jahr: new Date().getFullYear() - 1, posten: [] };
    o.nk.jahr = Number(val('nk-jahr')) || o.nk.jahr;
    o.nk.posten.forEach(function (p, i) {
      const el = root.querySelector('#nk-n-' + i);
      if (!el) return;
      p.name = el.value.trim();
      p.betrag = numVal('nk-b-' + i);
      p.schluessel = val('nk-s-' + i);
    });
  }

  function pruefLesen() {
    const o = findObj(modal.oid);
    if (!o.pruefungen) o.pruefungen = [];
    o.pruefungen.forEach(function (pr, i) {
      const nEl = root.querySelector('#w-n-' + i);
      if (!nEl) return;
      pr.name = nEl.value.trim();
      pr.letzte = root.querySelector('#w-d-' + i).value;
      pr.intervall = Number(root.querySelector('#w-i-' + i).value) || 12;
    });
  }

  function pvSpeichern() {
    const o = findObj(modal.oid);
    o.pv = {
      jahr: Number(val('pv-jahr')) || new Date().getFullYear() - 1,
      rabatt: numVal('pv-rabatt'),
      arbeitspreis: numVal('pv-arbeit'),
      grundpreis: numVal('pv-grund'),
      netzpreis: numVal('pv-netz'),
      netzGrundpreis: numVal('pv-netzgrund'),
      solarKwh: numVal('pv-solar'),
      netzKwh: numVal('pv-netzkwh')
    };
    o.units.forEach(function (x) {
      if (!root.querySelector('#z-' + x.id)) return;
      x.zaehler = val('z-' + x.id);
      x.kwhStart = numVal('a-' + x.id);
      x.kwhEnde = numVal('e-' + x.id);
      x.abschlagStrom = numVal('b-' + x.id);
      x.monateStrom = numVal('m-' + x.id);
    });
    save('Berechnet und gespeichert');
    render();
  }

  function pvText(uid) {
    const o = findObj(modal.oid);
    const x = o.units.find(function (z) { return z.id === uid; });
    const p = pvEinstellungen(o);
    const r = stromRechnung(o, x);
    const eur = function (v) { return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; };
    const kwh = function (v) { return Math.round(v).toLocaleString('de-DE') + ' kWh'; };

    const text = [
      'Stromabrechnung ' + p.jahr,
      o.name,
      x.name + (x.tenant ? ' — ' + x.tenant : ''),
      x.zaehler ? 'Zähler: ' + x.zaehler : '',
      '',
      'Zählerstand alt: ' + kwh(n(x.kwhStart)),
      'Zählerstand neu: ' + kwh(n(x.kwhEnde)),
      'Verbrauch: ' + kwh(r.verbrauch),
      '',
      'Strommix der Anlage: ' + Math.round(r.anteil * 100) + ' % Solar, '
        + Math.round((1 - r.anteil) * 100) + ' % Netz',
      'Solarstrom: ' + kwh(r.solarKwh) + ' zu '
        + (n(p.arbeitspreis) * (1 - n(p.rabatt) / 100)).toFixed(2).replace('.', ',') + ' ct/kWh = ' + eur(r.arbeitSolar),
      'Netzstrom: ' + kwh(r.netzKwh) + ' zu '
        + n(p.netzpreis).toFixed(2).replace('.', ',') + ' ct/kWh = ' + eur(r.arbeitNetz),
      'Grundpreis (' + r.monate + ' Monate): ' + eur(r.grund),
      '',
      'Kosten gesamt: ' + eur(r.summe),
      'Abschläge (' + r.monate + ' x ' + eur(n(x.abschlagStrom)) + '): ' + eur(r.gezahlt),
      (r.saldo >= 0 ? 'Nachzahlung: ' : 'Guthaben: ') + eur(Math.abs(r.saldo)),
      '',
      'Empfohlener Abschlag ab sofort: ' + eur(r.neuerAbschlag) + ' monatlich',
      '',
      'Grundlage: Grundversorgungstarif ' + n(p.arbeitspreis).toFixed(2).replace('.', ',')
        + ' ct/kWh und ' + eur(n(p.grundpreis)) + ' Grundbetrag pro Monat, abzüglich '
        + n(p.rabatt) + ' % auf den Solaranteil gemäß Anlage PV zum Mietvertrag.'
    ].filter(function (z) { return z !== null; }).join('\n');

    navigator.clipboard.writeText(text)
      .then(function () { toast('Abrechnungstext kopiert'); })
      .catch(function () { kopierDialog(text); });
  }

  function val(id) { const el = root.querySelector('#' + id); return el ? el.value.trim() : ''; }
  function numVal(id) { const v = val(id); return v === '' ? null : Number(v); }

  function captureUnit() {
    const x = modal.unit;
    x.name = val('m-name') || x.name; x.type = val('m-type'); x.status = val('m-status');
    x.tenant = val('m-tenant'); x.contact = val('m-contact');
    x.movein = val('m-movein'); x.lastIncrease = val('m-inc');
    x.area = numVal('m-area'); x.deposit = numVal('m-deposit');
    x.rent = numVal('m-rent'); x.nk = numVal('m-nk');
    x.parking = numVal('m-parking'); x.kitchen = numVal('m-kitchen');
    x.note = val('m-note');
    if (x.tenant) x.hint = '';
  }

  function addDoc() {
    const name = val('m-docname'), url = val('m-docurl');
    if (!name || !url) { toast('Name und Link werden beide gebraucht'); return; }
    if (!/^https?:\/\//i.test(url)) { toast('Der Link muss mit https:// beginnen'); return; }
    captureUnit();
    modal.unit.docs.push({ name: name, url: url });
    render();
  }

  function saveUnit() {
    const name = val('m-name');
    if (!name) { toast('Die Einheit braucht eine Bezeichnung'); return; }
    captureUnit();
    modal.unit.name = name;
    if (modal.isNew) findObj(modal.oid).units.push(modal.unit);
    open[modal.oid] = true; modal = null; save('Gespeichert'); render();
  }

  function saveObject() {
    const name = val('m-oname');
    if (!name) { toast('Das Objekt braucht einen Namen'); return; }
    const o = modal.object;
    o.name = name; o.note = val('m-onote');
    o.benchmark = numVal('m-bench');
    o.ordnerId = val('m-ordner');
    o.mietspiegel = val('m-msname');
    o.mietspiegelUrl = val('m-msurl');
    o.mietspiegelBis = val('m-msbis');
    if (modal.isNew) { data.objects.push(o); open[o.id] = true; }
    modal = null; save('Gespeichert'); render();
  }

  function exportData() {
    const head = ['Objekt', 'Einheit', 'Art', 'Mieter', 'Kontakt', 'Einzug', 'Status', 'Fläche', 'Kaltmiete',
      'Küche', 'Stellplatz', 'Nettomiete', 'Nebenkosten', 'Gesamt', 'Kaution', 'Letzte Erhöhung', 'Dokumente', 'Notiz', 'Hinweis'];
    const lines = [head.join('\t')];
    data.objects.forEach(function (o) {
      if (!o.units.length) lines.push(o.name + '\t—' + '\t'.repeat(17));
      o.units.forEach(function (x) {
        lines.push([o.name, x.name, x.type, x.tenant, x.contact || '', x.movein || '', label(x.status),
          x.area == null ? '' : x.area, x.rent == null ? '' : x.rent, x.kitchen == null ? '' : x.kitchen,
          x.parking == null ? '' : x.parking, netto(x), x.nk == null ? '' : x.nk, brutto(x),
          kaution(x), x.lastIncrease || '',
          (x.docs || []).map(function (d) { return d.name + ' ' + d.url; }).join(' | '),
          x.note || '', (!x.tenant && x.hint) ? x.hint : ''].join('\t'));
      });
    });
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function () {
      toast('In die Zwischenablage kopiert — in Excel einfügen');
    }).catch(function () { kopierDialog(text); });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function (r) {
      swReg = r;
      return r.pushManager ? r.pushManager.getSubscription() : null;
    }).then(function (abo) {
      pushAbo = abo || null;
      if (phase === 'app') render();
    }).catch(function () { /* ohne Service Worker läuft die App normal weiter */ });
  }

  // Die Uhr im Tagesplan: die Jetzt-Linie wandert mit, Verstrichenes wird rot,
  // und um Mitternacht klappt die Seite auf den neuen Tag um.
  let kalUhrTag = null;
  setInterval(function () {
    if (typeof phase !== 'undefined' && phase !== 'app') return;
    const heute = heuteISO();
    if (kalUhrTag && kalUhrTag !== heute) { kalUhrTag = heute; render(); return; }
    kalUhrTag = heute;
    const linie = document.querySelector('.zjetzt');
    if (!linie) return;
    const j = new Date();
    const minuten = j.getHours() * 60 + j.getMinutes();
    linie.style.top = (minuten / 60 * KAL_HOEHE) + 'px';
    document.querySelectorAll('.ztermin.aufgabe[data-ende]').forEach(function (block) {
      if (Number(block.getAttribute('data-ende')) < minuten) block.classList.add('spaet');
    });
  }, 30000);

  // ---- Immer aktuell: beim Zurückkehren zur App und alle zehn Minuten nachladen ----
  // Was jemand anderes gespeichert hat, was in Todoist oder im Postfach neu ist, taucht so von selbst auf.
  // Ein offenes Fenster oder ein Feld, in dem gerade getippt wird, wird dabei nicht gestört.
  let zuletztAufgefrischt = Date.now(), frischLaeuft = false;
  async function auffrischen() {
    if (phase !== 'app' || frischLaeuft || speicherLaeuft || nochmalSpeichern) return;
    frischLaeuft = true;
    try {
      if (!modal) {
        const stand = await api('data');
        if (stand && stand.wann && (!zuletztGeaendert || stand.wann !== zuletztGeaendert.wann) && !speicherLaeuft) {
          await datenHolen();
        }
      }
      if (todoist.verbunden) { await alleLaden(); await planLaden(); }
      if (ansicht === 'post' && google.verbunden) await postLaden();
      zuletztAufgefrischt = Date.now();
      const tipptGerade = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(document.activeElement.tagName) !== -1;
      if (!tipptGerade && !document.getElementById('dialog')) render();
    } catch (e) { /* beim nächsten Mal */ }
    finally { frischLaeuft = false; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - zuletztAufgefrischt > 60 * 1000) auffrischen();
  });
  window.addEventListener('focus', function () {
    if (Date.now() - zuletztAufgefrischt > 60 * 1000) auffrischen();
  });
  setInterval(function () {
    if (document.visibilityState === 'visible' && Date.now() - zuletztAufgefrischt > 10 * 60 * 1000) auffrischen();
  }, 60 * 1000);

  // Aus der Morgenmeldung geöffnet: das Memo hervorheben und die Stimmen wecken
  try {
    if (typeof URLSearchParams === 'function'
        && new URLSearchParams(location.search).get('memo') === '1') {
      memoWunsch = true;
      ansicht = 'heute';
      if (history.replaceState) history.replaceState({}, '', location.pathname);
    }
    if (typeof URLSearchParams === 'function'
        && new URLSearchParams(location.search).get('plan') === '1') {
      planWunsch = true;
      ansicht = 'heute';
      if (history.replaceState) history.replaceState({}, '', location.pathname);
    }
  } catch (fehler) { /* egal */ }
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.getVoices();
      // Android und Windows liefern die Stimmen erst kurz nach dem Laden nach
      window.speechSynthesis.addEventListener('voiceschanged', function () {
        if (memoStimmenDa) return;
        memoStimmenDa = true;
        if (phase === 'app' && ansicht === 'heute') render();
      });
    } catch (fehler) { /* egal */ }
  }

  load();
})();
