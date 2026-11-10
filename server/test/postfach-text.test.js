'use strict';

// Signatur aus gesendeten Mails lesen und die einfache Wortsuche — ohne Mailserver.

const test = require('node:test');
const assert = require('node:assert/strict');
const { signaturAus, umlautVarianten, einfacheKriterien, ohneZitat } = require('../lib/postfach-text');

test('Fürs Suchverzeichnis: nur der eigene Text, ohne zitierte Vorgeschichte', function () {
  assert.equal(ohneZitat('Danke, passt.\n\nAm 09.11.2026 um 10:12 schrieb Herr X:\n> alte Mail'), 'Danke, passt.');
  assert.equal(ohneZitat('Hallo\n> zitiert\nweiter'), 'Hallo');
  assert.equal(ohneZitat('Nur ein Text ohne Zitat'), 'Nur ein Text ohne Zitat');
});

test('Signatur: der Block ab dem letzten Gruß vor dem Zitat, ohne mailto-Reste', function () {
  const mail = [
    'Hallo Frau Beispiel,', '', 'vielen Dank für Ihre Angaben.', '',
    'Mit freundlichen Grüßen', 'Louis Ziegler', '',
    'Beste Grüße!', '', 'Louis Ziegler Immobilienverwalter', 'Mob: 0170 0000000',
    'Email: louis@example.org<mailto:louis@example.org>', 'Musterfirma GmbH & Co. KG', '',
    'On Mon, Nov 09, 2026 02:55 PM, Frau Beispiel <frau@example.org> wrote:',
    '> Guten Tag, ich interessiere mich …', '> Beste Grüße', '> Frau Beispiel'
  ].join('\n');
  assert.equal(signaturAus(mail),
    'Beste Grüße!\n\nLouis Ziegler Immobilienverwalter\nMob: 0170 0000000\nEmail: louis@example.org\nMusterfirma GmbH & Co. KG');
});

test('Signatur: deutscher Zitatkopf und „Von:“-Block beenden die eigene Mail', function () {
  assert.equal(signaturAus('Passt.\n\nViele Grüße\nLouis\n\nAm 09.11.2026 um 10:12 schrieb Herr X:\n> Viele Grüße\n> X'), 'Viele Grüße\nLouis');
  assert.equal(signaturAus('Danke!\n\nGruß\nLouis Ziegler\n\nVon: Stadtwerke\nGesendet: Montag\nBetreff: Rechnung\n\nMit freundlichen Grüßen\nIhre Stadtwerke'),
    'Gruß\nLouis Ziegler');
});

test('Signatur: ohne Gruß oder nur der Gruß gibt es keine', function () {
  assert.equal(signaturAus('Kurz: passt so.'), '');
  assert.equal(signaturAus('Alles klar.\n\nGrüße'), '');
});

test('Wortsuche: Wörter einzeln, ä/ae-Schreibweisen, Satzzeichen weg', function () {
  assert.deepEqual(einfacheKriterien('Rechnung, Stadtwerke! a').begriffe, [['Rechnung'], ['Stadtwerke']]);
  assert.deepEqual(umlautVarianten('Müller'), ['Müller', 'Mueller']);
  assert.deepEqual(umlautVarianten('Straße'), ['Straße', 'Strasse']);
  assert.deepEqual(umlautVarianten('Bertha'), ['Bertha']);
});
