// -------------------------------------------------------------
//  Kaufrechner — liest Angebote aus den Suchauftrags-Mails von
//  ImmoScout24 und rechnet durch, ob sich ein Kauf lohnt.
//
//  Läuft im Browser (window.Kaufrechner) und auf dem Server
//  (require), damit beide genau gleich rechnen.
// -------------------------------------------------------------
(function (wurzel, fabrik) {
  const k = fabrik();
  if (typeof module === 'object' && module.exports) module.exports = k;
  else wurzel.Kaufrechner = k;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Annahmen, mit denen gerechnet wird — alles lässt sich in der App ändern
  const STANDARD = {
    ekProzent: 20,          // Eigenkapital in % vom Kaufpreis (Nebenkosten zahlt man zusätzlich selbst)
    zins: 3.8,              // Sollzins % pro Jahr
    tilgung: 2,             // anfängliche Tilgung % pro Jahr
    grunderwerbsteuer: 5,   // Baden-Württemberg
    notar: 2,               // Notar und Grundbuch
    makler: 3.57,           // Käuferprovision inkl. MwSt.
    instandhaltung: 12,     // Rücklage €/m² und Jahr
    verwaltung: 30,         // Hausverwaltung €/Monat je Wohnung (bei Häusern nicht)
    mietausfall: 2,         // % der Jahresmiete
    abschlag: 10,           // % unter der Angebotsmiete — Mietspiegel und Mietpreisbremse
    mieteProQm: 11,         // falls aus den Mietangeboten keine Marktmiete abzulesen ist
    gebaeudeanteil: 75,     // Anteil des Gebäudes am Kaufpreis (nur das wird abgeschrieben)
    afa: 2,                 // Abschreibung % pro Jahr
    steuersatz: 42,         // persönlicher Grenzsteuersatz
    renovierungProQm: 400,  // €/m², wenn die Anzeige „renovierungsbedürftig“ o. ä. sagt (Kernsanierung: das 2,5-Fache)
    meldenAb: 70            // ab so vielen Punkten kommt eine Mitteilung aufs Handy
  };

  function annahmenMitStandard(a) {
    const erg = {};
    Object.keys(STANDARD).forEach(function (s) {
      const w = a ? Number(a[s]) : NaN;
      erg[s] = a && a[s] !== '' && a[s] !== null && isFinite(w) ? w : STANDARD[s];
    });
    return erg;
  }

  // "1.725 €" → 1725, "89,12 m²" → 89.12, "598–662 €" → 630 (Mitte der Spanne)
  function zahl(text) {
    if (typeof text === 'number') return isFinite(text) ? text : null;
    const s = String(text || '');
    if (/^\s*\d+\.\d{1,2}\s*(?:%|€)?\s*$/.test(s)) return Number(s.replace(/[^\d.]/g, ''));   // "3.57" mit Punkt getippt
    const funde = s.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g);
    if (!funde) return null;
    const werte = funde.map(function (f) { return Number(f.replace(/\./g, '').replace(',', '.')); });
    if (werte.length >= 2 && /\d\s*[–-]\s*\d/.test(s)) return (werte[0] + werte[1]) / 2;
    return werte[0];
  }

  function ortAusAdresse(adresse) {
    const teile = String(adresse || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (!teile.length) return '';
    // "Straße 1, Waiblingen, Rems-Murr-Kreis" — der Ort steht vor dem Kreis
    if (teile.length >= 2 && /kreis|landkreis|region/i.test(teile[teile.length - 1])) return teile[teile.length - 2];
    return teile[teile.length - 1];
  }

  function artRaten(betreff, preis) {
    const b = String(betreff || '').toLowerCase();
    if (/kauf|eigentum|buy/.test(b)) return 'kauf';
    if (/miet|rent/.test(b)) return 'miete';
    return preis && preis > 30000 ? 'kauf' : 'miete';
  }

  function typRaten(text) {
    const t = String(text || '').toLowerCase();
    if (/wohnung|apartment|appartement/.test(t)) return 'wohnung';
    if (/haus|house|villa|bungalow|doppelhaushälfte|dhh/.test(t)) return 'haus';
    return 'wohnung';
  }

  // Liest den Textteil einer ImmoScout24-Suchauftrags-Mail:
  //   Titel: …  Link: …/expose/123  Adresse: …  Kaufpreis|Kaltmiete: …  Wohnfläche: …  Zimmer: …
  function mailLesen(text, betreff) {
    const zeilen = String(text || '').replace(/\r/g, '').split('\n');
    const suche = (zeilen.find(function (z) { return /gespeicherten Suche/i.test(z); }) || '') + ' ' + (betreff || '');
    const angebote = [];
    let a = null;
    const abschliessen = function () {
      if (!a) return;
      const m = /expose\/(\d+)/.exec(a.link || '');
      if (m) {
        const preis = a.kaufpreis != null ? a.kaufpreis : a.miete;
        const art = a.kaufpreis != null ? 'kauf' : (a.miete != null ? 'miete' : artRaten(suche + ' ' + a.link, preis));
        angebote.push({
          id: 'is24:' + m[1],
          quelle: 'ImmoScout24',
          url: 'https://www.immobilienscout24.de/expose/' + m[1],
          art: art,
          typ: a.grundstueck ? 'haus' : typRaten(suche + ' ' + a.titel),
          titel: a.titel || '',
          adresse: a.adresse || '',
          ort: ortAusAdresse(a.adresse),
          preis: preis,
          flaeche: a.flaeche,
          zimmer: a.zimmer,
          grundstueck: a.grundstueck || null,
          merkmale: a.merkmale || ''
        });
      }
      a = null;
    };
    zeilen.forEach(function (roh) {
      const z = roh.trim();
      const feld = /^([A-Za-zÄÖÜäöüß\/ -]+):\s*(.*)$/.exec(z);
      if (feld && /^Titel$/i.test(feld[1].trim())) { abschliessen(); a = { titel: feld[2].trim() }; return; }
      if (!a) return;
      if (/^-{5,}/.test(z)) { abschliessen(); return; }
      if (!feld) { if (z && !a.merkmale && a.link) a.merkmale = z; return; }
      const name = feld[1].trim().toLowerCase();
      const wert = feld[2].trim();
      if (name === 'link') a.link = wert;
      else if (name === 'adresse') a.adresse = wert;
      else if (name === 'kaufpreis') a.kaufpreis = zahl(wert);
      else if (name === 'kaltmiete' || name === 'warmmiete' || name === 'miete') { if (a.miete == null) a.miete = zahl(wert); }
      else if (name === 'preis') a[artRaten(suche, zahl(wert)) === 'kauf' ? 'kaufpreis' : 'miete'] = zahl(wert);
      else if (name === 'wohnfläche' || name === 'wohnflaeche') a.flaeche = zahl(wert);
      else if (name === 'zimmer') a.zimmer = zahl(wert);
      else if (name.indexOf('grundstück') === 0 || name.indexOf('grundstueck') === 0) a.grundstueck = zahl(wert);
      else if (z && !a.merkmale && a.link) a.merkmale = z;
    });
    abschliessen();
    return angebote;
  }

  // Für eingefügten Text aus einem Exposé: das Wichtigste herausfischen
  function freiLesen(text) {
    const t = String(text || '');
    const finde = function (re) { const m = re.exec(t); return m ? zahl(m[1]) : null; };
    const link = /(https?:\/\/\S+)/.exec(t);
    return {
      url: link ? link[1] : '',
      preis: finde(/Kaufpreis[:\s]*([\d.,]+)/i),
      flaeche: finde(/Wohnfl(?:ä|ae)che[^\d]{0,20}([\d.,]+)/i) || finde(/([\d.,]+)\s*m²\s*Wohnfl/i),
      zimmer: finde(/Zimmer[:\s]*([\d,]+)/i) || finde(/([\d,]+)\s*Zi(?:mmer|\.)/i),
      grundstueck: finde(/Grundst(?:ü|ue)ck[^\d]{0,20}([\d.,]+)/i),
      miete: finde(/(?:Ist-?Miete|Mieteinnahmen|Kaltmiete)[^\d]{0,30}([\d.,]+)/i),
      hausgeld: finde(/Hausgeld[^\d]{0,20}([\d.,]+)/i)
    };
  }

  function median(werte) {
    if (!werte.length) return null;
    const s = werte.slice().sort(function (x, y) { return x - y; });
    const mitte = Math.floor(s.length / 2);
    return s.length % 2 ? s[mitte] : (s[mitte - 1] + s[mitte]) / 2;
  }

  function gleicherOrt(x, ort) {
    return !!ort && String(x || '').toLowerCase() === String(ort).toLowerCase();
  }

  // Was Wohnungen in diesem Ort gerade pro m² kosten — aus den Mietangeboten der Suchaufträge
  function marktmiete(mietangebote, ort) {
    const proQm = function (liste) {
      return liste.filter(function (m) { return m.preis > 0 && m.flaeche > 10; })
        .map(function (m) { return m.preis / m.flaeche; })
        .filter(function (w) { return w >= 4 && w <= 40; });   // Ausreißer und Tippfehler weg
    };
    const hier = proQm((mietangebote || []).filter(function (m) { return gleicherOrt(m.ort, ort); }));
    if (hier.length >= 5) return { proQm: median(hier), anzahl: hier.length, ort: ort };
    const alle = proQm(mietangebote || []);
    if (alle.length >= 5) return { proQm: median(alle), anzahl: alle.length, ort: null };
    return null;
  }

  // Üblicher Kaufpreis pro m² für Vergleichbares im selben Ort
  function marktpreis(kaufangebote, ort, typ) {
    const werte = (kaufangebote || []).filter(function (k) {
      return gleicherOrt(k.ort, ort) && (k.typ || 'wohnung') === (typ || 'wohnung') && k.preis > 0 && k.flaeche > 10;
    }).map(function (k) { return k.preis / k.flaeche; });
    return werte.length >= 4 ? { proQm: median(werte), anzahl: werte.length } : null;
  }

  function grenzen(x, unten, oben) { return Math.min(oben, Math.max(unten, x)); }
  function positiv(x) { const z = Number(x); return isFinite(z) && z > 0 ? z : 0; }

  // Die eigentliche Rechnung. a: Angebot (mit eigenen Ergänzungen), annahmen, umfeld: { mieteProQm, marktPreisQm }
  function rechnen(a, annahmen, umfeld) {
    const p = annahmenMitStandard(annahmen);
    umfeld = umfeld || {};
    const preis = positiv(a.preis);
    const flaeche = positiv(a.flaeche);
    const fehlt = [];
    if (!preis) fehlt.push('Kaufpreis');
    if (!flaeche && !positiv(a.miete)) fehlt.push('Wohnfläche');
    if (fehlt.length) return { vollstaendig: false, fehlt: fehlt, punkte: null, urteil: 'unvollstaendig' };

    const haus = a.typ === 'haus';
    const mieteProQm = positiv(umfeld.mieteProQm) || p.mieteProQm;
    const mieteGeschaetzt = !positiv(a.miete);
    const miete = mieteGeschaetzt ? flaeche * mieteProQm * (1 - p.abschlag / 100) : positiv(a.miete);
    const jahresmiete = miete * 12;

    const maklerProzent = a.makler === 0 || a.makler === '0' ? 0 : (positiv(a.makler) || p.makler);
    const nebenkostenProzent = p.grunderwerbsteuer + p.notar + maklerProzent;
    const nebenkosten = preis * nebenkostenProzent / 100;
    const renovierung = positiv(a.renovierung);
    const gesamt = preis + nebenkosten + renovierung;

    // Laufende Kosten, die der Mieter nicht trägt
    const hausgeld = positiv(a.hausgeld);
    const laufend = hausgeld
      ? hausgeld * 12
      : flaeche * p.instandhaltung + (haus ? 0 : p.verwaltung * 12);
    const ausfall = jahresmiete * p.mietausfall / 100;
    const bewirtschaftung = laufend + ausfall;

    const darlehen = preis * (1 - p.ekProzent / 100);
    const eigenkapital = gesamt - darlehen;
    const zinsJahr = darlehen * p.zins / 100;
    const tilgungJahr = darlehen * p.tilgung / 100;
    const rate = (zinsJahr + tilgungJahr) / 12;

    const cashflow = (jahresmiete - bewirtschaftung - zinsJahr - tilgungJahr) / 12;
    const afaJahr = (preis + nebenkosten) * p.gebaeudeanteil / 100 * (positiv(a.afa) || p.afa) / 100;
    const ergebnisSteuer = jahresmiete - bewirtschaftung - zinsJahr - afaJahr;
    const steuerJahr = ergebnisSteuer * p.steuersatz / 100;   // negativ = Erstattung
    const cashflowNachSteuer = cashflow - steuerJahr / 12;

    // Eine nötige Renovierung gehört zum Preis: Rendite und Vergleich rechnen mit beidem
    const einstand = preis + renovierung;
    const brutto = jahresmiete / einstand * 100;
    const netto = (jahresmiete - bewirtschaftung) / gesamt * 100;
    const faktor = einstand / jahresmiete;
    const preisQm = flaeche ? preis / flaeche : null;
    const ekRendite = eigenkapital > 0 ? (cashflowNachSteuer * 12 + tilgungJahr) / eigenkapital * 100 : null;

    // Punkte 0–100: Rendite zählt am meisten, dann was monatlich übrig bleibt, dann der Preis im Vergleich
    const pRendite = grenzen((brutto - 3) / 3, 0, 1) * 45;
    const proHundertTausend = cashflowNachSteuer / einstand * 100000;
    const pCashflow = grenzen((proHundertTausend + 250) / 350, 0, 1) * 35;
    const marktPreisQm = positiv(umfeld.marktPreisQm);
    const pPreis = marktPreisQm && preisQm ? grenzen((1.25 - einstand / flaeche / marktPreisQm) / 0.45, 0, 1) * 20 : 10;
    const punkte = Math.round(pRendite + pCashflow + pPreis);

    return {
      vollstaendig: true, fehlt: [],
      miete: miete, mieteGeschaetzt: mieteGeschaetzt, mieteProQm: mieteGeschaetzt ? mieteProQm * (1 - p.abschlag / 100) : (flaeche ? miete / flaeche : null),
      jahresmiete: jahresmiete,
      nebenkosten: nebenkosten, nebenkostenProzent: nebenkostenProzent, renovierung: renovierung, gesamt: gesamt,
      laufend: laufend, ausfall: ausfall, bewirtschaftung: bewirtschaftung, hausgeldBekannt: !!hausgeld,
      darlehen: darlehen, eigenkapital: eigenkapital, zinsJahr: zinsJahr, tilgungJahr: tilgungJahr, rate: rate,
      cashflow: cashflow, afaJahr: afaJahr, steuerJahr: steuerJahr, cashflowNachSteuer: cashflowNachSteuer,
      brutto: brutto, netto: netto, faktor: faktor, preisQm: preisQm, marktPreisQm: marktPreisQm || null,
      ekRendite: ekRendite,
      teile: { rendite: Math.round(pRendite), cashflow: Math.round(pCashflow), preis: Math.round(pPreis) },
      punkte: punkte,
      urteil: punkte >= 70 ? 'gut' : (punkte >= 50 ? 'mittel' : 'schwach')
    };
  }

  // Bis zu welchem Kaufpreis wäre das Angebot "gut" (≥ 70 Punkte)? Für die Verhandlung.
  function zielpreis(a, annahmen, umfeld) {
    const r = rechnen(a, annahmen, umfeld);
    if (!r.vollstaendig) return null;
    if (r.punkte >= 70) return a.preis;
    let unten = 0, oben = positiv(a.preis);
    for (let i = 0; i < 30; i++) {
      const mitte = (unten + oben) / 2;
      const t = rechnen(Object.assign({}, a, { preis: mitte }), annahmen, umfeld);
      if (t.punkte >= 70) unten = mitte; else oben = mitte;
    }
    return unten > 0 ? Math.floor(unten / 1000) * 1000 : null;
  }

  function leer(v) { return v === undefined || v === null || v === ''; }

  // Wie viele m² ein Zimmer im Ort typischerweise hat — aus allen Angeboten mit beiden Angaben
  function qmProZimmer(angebote, ort) {
    const werte = function (liste) {
      return liste.filter(function (x) { return positiv(x.flaeche) && positiv(x.zimmer); })
        .map(function (x) { return x.flaeche / x.zimmer; }).filter(function (w) { return w >= 12 && w <= 60; });
    };
    const hier = werte((angebote || []).filter(function (x) { return gleicherOrt(x.ort, ort); }));
    if (hier.length >= 5) return median(hier);
    const alle = werte(angebote || []);
    return alle.length >= 5 ? median(alle) : null;
  }

  const RENOVIERUNG = [
    [/kernsanier|entkernt|rohbau|abrissreif|sanierungsobjekt/i, 2.5, 'Kernsanierung laut Anzeige'],
    [/renovierungsbed(?:ü|ue)rftig|sanierungsbed(?:ü|ue)rftig|modernisierungsbed(?:ü|ue)rftig|renovierungsstau|sanierungsstau|handwerker|liebhaber|bastler|zum herrichten|renovierung n(?:ö|oe)tig/i, 1, 'renovierungsbedürftig laut Anzeige']
  ];

  // Was in der Mail fehlt, ergänzt die App selbst — und sagt dazu, woher der Wert kommt.
  // Was selbst eingetragen ist, bleibt immer unangetastet.
  function ergaenzen(a, annahmen, umfeld) {
    const p = annahmenMitStandard(annahmen);
    umfeld = umfeld || {};
    const text = [a.titel, a.merkmale].filter(Boolean).join(' ');
    const werte = {}, warum = {};

    if (!positiv(a.flaeche)) {
      const m = /(\d{2,3}(?:,\d+)?)\s*(?:m²|m2|qm)(?![a-z])/i.exec(text);
      if (m) { werte.flaeche = zahl(m[1]); warum.flaeche = 'aus dem Titel'; }
      else if (positiv(a.zimmer)) {
        const proZimmer = positiv(umfeld.qmProZimmer) || (a.typ === 'haus' ? 30 : 27);
        werte.flaeche = Math.round(a.zimmer * proZimmer);
        warum.flaeche = 'geschätzt: ' + String(a.zimmer).replace('.', ',') + ' Zimmer × ' + Math.round(proZimmer) + ' m²';
      }
    }
    const flaeche = positiv(a.flaeche) || werte.flaeche || 0;

    if (!positiv(a.miete)) {
      const m = /(?:mieteinnahmen?|ist-?miete|nettokaltmiete|kaltmiete|miete)\D{0,20}?(\d{1,3}(?:\.\d{3})*(?:,\d+)?)\s*(?:€|eur)\s*(p\.?\s?a\.?|j(?:ä|ae)hrlich|pro jahr|im jahr|\/\s*jahr)?/i.exec(text);
      const r = /(\d{1,2}(?:,\d+)?)\s*%\s*(?:brutto|ist-?)?rendite|rendite\D{0,12}(\d{1,2}(?:,\d+)?)\s*%/i.exec(text);
      if (m) {
        const betrag = zahl(m[1]) / (m[2] ? 12 : 1);
        if (betrag >= 100 && betrag <= 30000 && (!positiv(a.preis) || betrag < a.preis / 40)) {
          werte.miete = Math.round(betrag); warum.miete = 'Miete laut Anzeige';
        }
      } else if (r && positiv(a.preis)) {
        const prozent = zahl(r[1] || r[2]);
        if (prozent >= 1 && prozent <= 15) { werte.miete = Math.round(a.preis * prozent / 100 / 12); warum.miete = 'aus ' + String(prozent).replace('.', ',') + ' % Rendite laut Anzeige'; }
      }
    }

    if (leer(a.makler) && /provisionsfrei|ohne makler|keine (?:k(?:ä|ae)ufer)?provision|von privat|privatverkauf/i.test(text)) {
      werte.makler = 0; warum.makler = 'provisionsfrei laut Anzeige';
    }

    if (leer(a.renovierung) && flaeche) {
      const treffer = RENOVIERUNG.find(function (t) { return t[0].test(text); });
      if (treffer) {
        werte.renovierung = Math.round(flaeche * p.renovierungProQm * treffer[1] / 1000) * 1000;
        warum.renovierung = treffer[2] + ' (' + Math.round(p.renovierungProQm * treffer[1]) + ' €/m²)';
      }
    }

    if (leer(a.afa) && /neubau|erstbezug(?!\s*nach)|baujahr\s*20(?:2[3-9]|3\d)/i.test(text)) {
      werte.afa = 3; warum.afa = 'Neubau: 3 % Abschreibung';
    }

    if (/\bvermietet\b|kapitalanlage/i.test(text) && !/unvermietet|nicht vermietet|bezugsfrei|leerstehend/i.test(text) && !positiv(a.miete) && !werte.miete) {
      warum.vermietet = 'laut Anzeige vermietet — gerechnet mit der Marktmiete, die echte Miete steht im Exposé';
    }
    return { werte: werte, warum: warum };
  }

  // Alles zusammen: Angebot + Marktumfeld → Kennzahlen
  function bewerten(a, annahmen, mietangebote, kaufangebote) {
    const mm = marktmiete(mietangebote, a.ort);
    const mp = marktpreis((kaufangebote || []).filter(function (k) { return k.id !== a.id; }), a.ort, a.typ);
    const umfeld = { mieteProQm: mm ? mm.proQm : null, marktPreisQm: mp ? mp.proQm : null };
    const erg = ergaenzen(a, annahmen, { qmProZimmer: qmProZimmer((mietangebote || []).concat(kaufangebote || []), a.ort) });
    const voll = Object.assign({}, a, erg.werte);
    const r = rechnen(voll, annahmen, umfeld);
    r.marktmiete = mm;
    r.marktpreis = mp;
    r.ergaenzt = erg.werte;
    r.warum = erg.warum;
    r.flaeche = positiv(voll.flaeche) || null;
    r.zielpreis = r.vollstaendig && r.punkte < 70 ? zielpreis(voll, annahmen, umfeld) : null;
    return r;
  }

  return { STANDARD, annahmenMitStandard, zahl, ortAusAdresse, mailLesen, freiLesen, marktmiete, marktpreis, qmProZimmer, ergaenzen, rechnen, zielpreis, bewerten, median };
});
