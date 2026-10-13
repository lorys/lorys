import test from 'node:test';
import assert from 'node:assert/strict';
import { addressFromMapsUrl, parseMapsUrl } from '../src/maps.js';

test('extrait nom et adresse d\'un lien /maps/place/', () => {
  const url = 'https://www.google.com/maps/place/Boulangerie+Dupont,+12+Rue+de+la+Paix,+75002+Paris/@48.86,2.33,17z/data=!3m1';
  assert.deepEqual(parseMapsUrl(url), { name: 'Boulangerie Dupont', address: '12 Rue de la Paix, 75002 Paris' });
});

test('gère les adresses seules, les requêtes ?q= et les coordonnées', () => {
  assert.deepEqual(parseMapsUrl('https://www.google.com/maps/place/12+Rue+X,+Lyon/'), { address: '12 Rue X, Lyon' });
  assert.deepEqual(parseMapsUrl('https://maps.google.com/?q=Caf%C3%A9+du+Port,+Brest'), { name: 'Café du Port', address: 'Brest' });
  assert.deepEqual(parseMapsUrl('https://maps.google.com/?q=48.1,-1.6'), {});
  assert.deepEqual(parseMapsUrl('pas une url'), {});
});

test('suit les liens courts vers Google uniquement', async () => {
  const redirect = (location) => ({ headers: new Headers({ location }) });
  const google = async () => redirect('https://www.google.com/maps/place/Chez+Paul,+1+Place+Y,+Nantes/');
  assert.equal(await addressFromMapsUrl('https://maps.app.goo.gl/abc', google), '1 Place Y, Nantes');
  const evil = async () => redirect('https://evil.example/maps/place/A,+B/');
  assert.equal(await addressFromMapsUrl('https://maps.app.goo.gl/abc', evil), null);
  const failing = async () => { throw new Error('réseau'); };
  assert.equal(await addressFromMapsUrl('https://maps.app.goo.gl/abc', failing), null);
});
