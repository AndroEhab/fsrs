import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  deleteFlashcard,
  attachImage,
  ImageValidationError,
  listImages,
  refreshOwnedCardImageUrls,
  removeImage,
  uploadImage,
} from './service';
import { MAX_CARD_IMAGES } from './types';

const DEMO_PROJECT_ID = 'demo-fsrs-datastore-test';
const runId = randomUUID();
const EMULATOR_HOST_PATTERN = /^(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/;
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '';
const HAS_STORAGE_EMULATOR = EMULATOR_HOST_PATTERN.test(STORAGE_HOST);
const NO_STORAGE_PREFLIGHT = process.env.FSRS_IMAGE_NO_STORAGE_PREFLIGHT === 'true';
const fixtureOwners = new Set<string>();
const fixtureCardIds = new Set<string>();
const db = (() => {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
    ?? (process.env.FIRESTORE_EMULATOR_PORT ? `127.0.0.1:${process.env.FIRESTORE_EMULATOR_PORT}` : '');
  const match = EMULATOR_HOST_PATTERN.exec(emulatorHost);
  if (!match || Number(match[2]) > 65535) {
    throw new Error(`Image lifecycle tests require a localhost Firestore emulator; got ${emulatorHost || '(unset)'}`);
  }
  if (process.env.FSRS_DATASTORE_PROJECT_ID !== DEMO_PROJECT_ID
      || process.env.GCLOUD_PROJECT !== DEMO_PROJECT_ID
      || process.env.GOOGLE_CLOUD_PROJECT !== DEMO_PROJECT_ID) {
    throw new Error('Image lifecycle tests require the explicit demo project demo-fsrs-datastore-test');
  }
  if (!HAS_STORAGE_EMULATOR && !NO_STORAGE_PREFLIGHT) {
    throw new Error(`Image lifecycle tests require a localhost Storage emulator; got ${STORAGE_HOST || '(unset)'}`);
  }
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  initializeApp({
    projectId: DEMO_PROJECT_ID,
    ...(HAS_STORAGE_EMULATOR ? { storageBucket: `${DEMO_PROJECT_ID}.appspot.com` } : {}),
    credential: cert({
      projectId: DEMO_PROJECT_ID,
      clientEmail: `image-tests@${DEMO_PROJECT_ID}.iam.gserviceaccount.com`,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  });
  return getFirestore();
})();

function ownerFor(testName: string): string {
  const ownerId = `image-test-${runId}-${testName}`;
  fixtureOwners.add(ownerId);
  return ownerId;
}

function cardIdFor(testName: string): string {
  const cardId = `image-${runId}-${testName}`;
  fixtureCardIds.add(cardId);
  return cardId;
}

function cardDocument(ownerId: string, images: Array<Record<string, unknown>> = []) {
  const now = Timestamp.now();
  return {
    ownerId,
    front: 'Image lifecycle question',
    back: 'Image lifecycle answer',
    tags: [],
    suspended: false,
    createdAt: now,
    updatedAt: now,
    due: now,
    state: 2,
    stability: 3.5,
    difficulty: 4,
    reps: 7,
    lapses: 1,
    reviewLog: [],
    images,
  };
}

async function cleanupOwner(ownerId: string): Promise<void> {
  const cards = await db.collection('flashcards').where('ownerId', '==', ownerId).get();
  const batch = db.batch();
  for (const card of cards.docs) batch.delete(card.ref);
  await batch.commit();
}

async function cleanupStorage(): Promise<void> {
  const bucket = getStorage().bucket();
  for (const cardId of fixtureCardIds) {
    const [files] = await bucket.getFiles({ prefix: `card-images/${cardId}/` });
    await Promise.all(files.map((file) => file.delete().catch(() => undefined)));
  }
}

afterAll(async () => {
  for (const ownerId of fixtureOwners) await cleanupOwner(ownerId);
  if (HAS_STORAGE_EMULATOR) await cleanupStorage();
  await db.terminate();
});

describe('real Firestore image lifecycle regressions', () => {
  it('serializes concurrent attachments at capacity without losing committed images or changing scheduling state', async () => {
    const ownerId = ownerFor('capacity-race');
    const cardId = cardIdFor('capacity-race');
    const initialImages = Array.from({ length: MAX_CARD_IMAGES - 1 }, (_, index) => ({
      id: `existing-${index}`,
      url: `https://images.example.test/existing-${index}.png`,
      addedAt: Timestamp.now(),
    }));
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId, initialImages));
    const before = (await ref.get()).data()!;

    const results = await Promise.allSettled([
      attachImage(cardId, { url: 'https://images.example.test/concurrent-a.png' }, ownerId),
      attachImage(cardId, { url: 'https://images.example.test/concurrent-b.png' }, ownerId),
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ImageValidationError);

    const after = (await ref.get()).data()!;
    expect(after.images).toHaveLength(MAX_CARD_IMAGES);
    expect((after.images as Array<{ id: string }>).map((image) => image.id)).toEqual([
      ...initialImages.map((image) => image.id),
      expect.any(String),
    ]);
    expect(after).toMatchObject({
      ownerId,
      front: before.front,
      back: before.back,
      createdAt: before.createdAt,
      due: before.due,
      state: before.state,
      stability: before.stability,
      difficulty: before.difficulty,
      reps: before.reps,
      lapses: before.lapses,
      reviewLog: before.reviewLog,
    });
  }, 30_000);
  it('returns the committed updatedAt for both direct attachments and Storage uploads', async () => {
    const ownerId = ownerFor('updated-at-response');
    const cardId = cardIdFor('updated-at-response');
    const ref = db.collection('flashcards').doc(cardId);
    const oldUpdatedAt = Timestamp.fromDate(new Date('2000-01-01T00:00:00.000Z'));
    await ref.create({ ...cardDocument(ownerId), updatedAt: oldUpdatedAt });
    const before = (await ref.get()).data()!;

    const attached = await attachImage(cardId, { url: 'https://images.example.test/timestamp.png' }, ownerId);
    const afterAttach = (await ref.get()).data()!;
    const uploaded = await uploadImage(cardId, {
      data: Buffer.from('timestamp image bytes').toString('base64'),
      fileName: 'timestamp.png',
      contentType: 'image/png',
    }, ownerId);
    const afterUpload = (await ref.get()).data()!;

    expect([attached?.card.updatedAt, uploaded?.card.updatedAt])
      .toEqual([afterAttach.updatedAt, afterUpload.updatedAt]);
    expect(afterAttach.updatedAt).not.toEqual(oldUpdatedAt);
    expect(afterUpload.updatedAt).not.toEqual(oldUpdatedAt);
    expect(afterAttach).toMatchObject({
      due: before.due,
      state: before.state,
      stability: before.stability,
      difficulty: before.difficulty,
      reps: before.reps,
      lapses: before.lapses,
      reviewLog: before.reviewLog,
    });
    expect(afterUpload).toMatchObject({
      due: before.due,
      state: before.state,
      stability: before.stability,
      difficulty: before.difficulty,
      reps: before.reps,
      lapses: before.lapses,
      reviewLog: before.reviewLog,
    });



  });

  it('does not attach to a card owned by another account and removes only the exact committed direct URL', async () => {
    const ownerId = ownerFor('ownership-and-removal');
    const foreignOwnerId = ownerFor('foreign-owner');
    const cardId = cardIdFor('ownership-and-removal');
    const imageUrl = 'https://images.example.test/owned.png?variant=one';
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId, [{ id: 'direct-image', url: imageUrl, addedAt: Timestamp.now() }]));
    const before = (await ref.get()).data()!;

    await expect(attachImage(cardId, { url: 'https://images.example.test/foreign.png' }, foreignOwnerId)).resolves.toBeNull();
    expect((await ref.get()).data()?.images).toEqual(before.images);

    await expect(removeImage(cardId, 'https://images.example.test/owned.png', ownerId))
      .resolves.toMatchObject({ cardId, removed: false });
    expect((await ref.get()).data()?.images).toEqual(before.images);
    await expect(removeImage(cardId, imageUrl, ownerId)).resolves.toMatchObject({ cardId, removed: true });
    expect((await ref.get()).data()?.images).toEqual([]);
    await expect(removeImage(cardId, imageUrl, ownerId)).resolves.toMatchObject({ cardId, removed: false });
  });

  it('does not remove a foreign card even when the caller supplies its exact image URL', async () => {
    const ownerId = ownerFor('foreign-removal');
    const foreignOwnerId = ownerFor('foreign-removal-owner');
    const cardId = cardIdFor('foreign-removal');
    const imageUrl = 'https://images.example.test/private.png';
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(foreignOwnerId, [{ id: 'foreign-image', url: imageUrl, addedAt: Timestamp.now() }]));

    await expect(removeImage(cardId, imageUrl, ownerId)).resolves.toBeNull();
    expect((await ref.get()).data()?.images).toHaveLength(1);
  });
  it('never deletes Storage metadata that is not under the exact owning card path', async () => {
    const ownerId = ownerFor('foreign-storage-path');
    const cardId = cardIdFor('foreign-storage-path');
    const otherCardId = cardIdFor('foreign-storage-path-target');
    const foreignPath = `card-images/${otherCardId}/${runId}.png`;
    const file = getStorage().bucket().file(foreignPath);
    await file.save(Buffer.from('not owned by selected card'), { contentType: 'image/png' });
    const imageUrl = 'https://images.example.test/metadata-only.png';
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId, [{
      id: 'foreign-path-image',
      url: imageUrl,
      storagePath: foreignPath,
      addedAt: Timestamp.now(),
    }]));

    await expect(removeImage(cardId, imageUrl, ownerId)).resolves.toMatchObject({ removed: true });
    expect((await file.exists())[0]).toBe(true);
  });
  it('renews an expired Storage URL without changing card state and deletes only the owned committed object', async () => {
    const ownerId = ownerFor('storage-renew-and-remove');
    const cardId = cardIdFor('storage-renew-and-remove');
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId));

    const uploaded = await uploadImage(cardId, {
      data: Buffer.from('image lifecycle emulator bytes').toString('base64'),
      fileName: '../../lifecycle.png',
      contentType: 'image/png',
    }, ownerId);
    expect(uploaded).not.toBeNull();
    expect(uploaded!.image.storagePath).toMatch(new RegExp(`^card-images/${cardId}/[^/]+\\.png$`));
    const originalUrl = uploaded!.image.url;
    const file = getStorage().bucket().file(uploaded!.image.storagePath!);
    expect((await file.exists())[0]).toBe(true);

    const expiredUrl = new URL(originalUrl);
    if (expiredUrl.searchParams.has('Expires')) {
      expiredUrl.searchParams.set('Expires', '1');
    } else {
      expiredUrl.searchParams.set('X-Goog-Date', '19700101T000000Z');
      expiredUrl.searchParams.set('X-Goog-Expires', '1');
    }
    const beforeRenewal = (await ref.get()).data()!;
    await ref.update({
      images: [{ ...uploaded!.image, url: expiredUrl.toString(), downloadUrl: expiredUrl.toString() }],
    });

    const listed = await listImages(cardId, ownerId);
    expect(listed?.images[0].url).not.toBe(expiredUrl.toString());
    expect((await ref.get()).data()).toMatchObject({
      front: beforeRenewal.front,
      back: beforeRenewal.back,
      updatedAt: beforeRenewal.updatedAt,
      due: beforeRenewal.due,
      state: beforeRenewal.state,
      stability: beforeRenewal.stability,
      difficulty: beforeRenewal.difficulty,
      reps: beforeRenewal.reps,
      lapses: beforeRenewal.lapses,
      reviewLog: beforeRenewal.reviewLog,
    });

    await expect(removeImage(cardId, originalUrl, ownerId)).resolves.toMatchObject({ removed: true });
    expect((await file.exists())[0]).toBe(false);
    expect((await ref.get()).data()?.images).toEqual([]);
  });

  it('does not restore a removed image while renewing URLs from an older card snapshot', async () => {
    const ownerId = ownerFor('storage-no-resurrection');
    const cardId = cardIdFor('storage-no-resurrection');
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId));
    const storagePath = `card-images/${cardId}/${runId}.png`;
    const file = getStorage().bucket().file(storagePath);
    await file.save(Buffer.from('removed image bytes'), { contentType: 'image/png' });
    const [signedUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 60 * 60 * 1000 });
    const expiredUrl = new URL(signedUrl);
    if (expiredUrl.searchParams.has('Expires')) {
      expiredUrl.searchParams.set('Expires', '1');
    } else {
      expiredUrl.searchParams.set('X-Goog-Date', '19700101T000000Z');
      expiredUrl.searchParams.set('X-Goog-Expires', '1');
    }
    const staleImage = {
      id: 'removed-image',
      url: expiredUrl.toString(),
      downloadUrl: expiredUrl.toString(),
      storagePath,
      addedAt: Timestamp.now(),
    };
    await ref.update({ images: [staleImage] });
    await ref.update({ images: [] });

    const refreshed = await refreshOwnedCardImageUrls({ id: cardId, ownerId, images: [staleImage] }, ownerId);
    expect(refreshed.images).toEqual([]);
    expect((await ref.get()).data()?.images).toEqual([]);
  });

  it('does not persist refreshed URLs after a card changes owner', async () => {
    const originalOwnerId = ownerFor('storage-owner-change');
    const newOwnerId = ownerFor('storage-owner-change-new-owner');
    const cardId = cardIdFor('storage-owner-change');
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(originalOwnerId));
    const storagePath = `card-images/${cardId}/${runId}.png`;
    const file = getStorage().bucket().file(storagePath);
    await file.save(Buffer.from('moved image bytes'), { contentType: 'image/png' });
    const [signedUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 60 * 60 * 1000 });
    const expiredUrl = new URL(signedUrl);
    if (expiredUrl.searchParams.has('Expires')) {
      expiredUrl.searchParams.set('Expires', '1');
    } else {
      expiredUrl.searchParams.set('X-Goog-Date', '19700101T000000Z');
      expiredUrl.searchParams.set('X-Goog-Expires', '1');
    }
    const image = {
      id: 'moved-image',
      url: expiredUrl.toString(),
      downloadUrl: expiredUrl.toString(),
      storagePath,
      addedAt: Timestamp.now(),
    };
    await ref.update({ images: [image] });
    const beforeMove = (await ref.get()).data()!;
    await ref.update({ ownerId: newOwnerId });

    const refreshed = await refreshOwnedCardImageUrls({
      id: cardId,
      ownerId: originalOwnerId,
      images: [image],
    }, originalOwnerId);

    expect(refreshed.images).toEqual([]);
    expect((await ref.get()).data()).toMatchObject({
      ownerId: newOwnerId,
      images: beforeMove.images,
      updatedAt: beforeMove.updatedAt,
    });
  });

  const noStorageIt = NO_STORAGE_PREFLIGHT ? it : it.skip;
  noStorageIt('returns null for missing and foreign-owned uploads without Storage configuration', async () => {
    const ownerId = ownerFor('no-storage-preflight');
    const foreignOwnerId = ownerFor('no-storage-preflight-foreign');
    const missingCardId = cardIdFor('no-storage-preflight');
    const foreignCardId = cardIdFor('no-storage-preflight-foreign');
    await db.collection('flashcards').doc(foreignCardId).create(cardDocument(foreignOwnerId));

    const input = {
      data: Buffer.from('preflight image bytes').toString('base64'),
      fileName: 'preflight.png',
      contentType: 'image/png',
    };
    const results = await Promise.allSettled([
      uploadImage(missingCardId, input, ownerId),
      uploadImage(foreignCardId, input, ownerId),
    ]);
    expect(results).toEqual([
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: null },
    ]);
  });

  it('cleans up real Storage objects when an upload cannot attach to a missing or foreign-owned card', async () => {
    const ownerId = ownerFor('storage-orphan');
    const foreignOwnerId = ownerFor('storage-orphan-foreign-owner');
    const missingCardId = cardIdFor('storage-orphan');
    const foreignCardId = cardIdFor('storage-orphan-foreign');
    await db.collection('flashcards').doc(foreignCardId).create(cardDocument(foreignOwnerId));

    for (const cardId of [missingCardId, foreignCardId]) {
      await expect(uploadImage(cardId, {
        data: Buffer.from('orphan image bytes').toString('base64'),
        fileName: 'orphan.png',
        contentType: 'image/png',
      }, ownerId)).resolves.toBeNull();

      const [files] = await getStorage().bucket().getFiles({ prefix: `card-images/${cardId}/` });
      expect(files).toHaveLength(0);
    }
  });

  it('serializes concurrent uploads at the image limit and leaves no losing Storage object', async () => {
    const ownerId = ownerFor('storage-upload-race');
    const cardId = cardIdFor('storage-upload-race');
    const initialImages = Array.from({ length: MAX_CARD_IMAGES - 1 }, (_, index) => ({
      id: `existing-${index}`,
      url: `https://images.example.test/existing-${index}.png`,
      addedAt: Timestamp.now(),
    }));
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId, initialImages));
    const before = (await ref.get()).data()!;

    const results = await Promise.allSettled([
      uploadImage(cardId, {
        data: Buffer.from('concurrent image a').toString('base64'),
        fileName: 'concurrent-a.png',
        contentType: 'image/png',
      }, ownerId),
      uploadImage(cardId, {
        data: Buffer.from('concurrent image b').toString('base64'),
        fileName: 'concurrent-b.png',
        contentType: 'image/png',
      }, ownerId),
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ImageValidationError);

    const after = (await ref.get()).data()!;
    expect(after.images).toHaveLength(MAX_CARD_IMAGES);
    expect(after).toMatchObject({
      updatedAt: (accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof uploadImage>>>).value?.card.updatedAt,
      due: before.due,
      state: before.state,
      stability: before.stability,
      difficulty: before.difficulty,
      reps: before.reps,
      lapses: before.lapses,
      reviewLog: before.reviewLog,
    });
    const [files] = await getStorage().bucket().getFiles({ prefix: `card-images/${cardId}/` });
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe((accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof uploadImage>>>).value?.image.storagePath);
  });

  it('rejects upload at current image capacity before creating a Storage object', async () => {
    const ownerId = ownerFor('storage-capacity');
    const cardId = cardIdFor('storage-capacity');
    const initialImages = Array.from({ length: MAX_CARD_IMAGES }, (_, index) => ({
      id: `existing-${index}`,
      url: `https://images.example.test/existing-${index}.png`,
      addedAt: Timestamp.now(),
    }));
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId, initialImages));
    const before = (await ref.get()).data()!;

    await expect(uploadImage(cardId, {
      data: Buffer.from('capacity image bytes').toString('base64'),
      fileName: 'capacity.png',
      contentType: 'image/png',
    }, ownerId)).rejects.toBeInstanceOf(ImageValidationError);

    expect((await ref.get()).data()).toMatchObject({
      images: initialImages,
      updatedAt: before.updatedAt,
      due: before.due,
      state: before.state,
      stability: before.stability,
      difficulty: before.difficulty,
      reps: before.reps,
      lapses: before.lapses,
      reviewLog: before.reviewLog,
    });
    const [files] = await getStorage().bucket().getFiles({ prefix: `card-images/${cardId}/` });
    expect(files).toHaveLength(0);
  });

  it('deletes real owned Storage objects when the owning card is deleted', async () => {
    const ownerId = ownerFor('storage-card-delete');
    const cardId = cardIdFor('storage-card-delete');
    const ref = db.collection('flashcards').doc(cardId);
    await ref.create(cardDocument(ownerId));
    const file = getStorage().bucket().file(`card-images/${cardId}/${runId}.png`);
    await file.save(Buffer.from('owned image bytes'), { contentType: 'image/png' });

    await expect(deleteFlashcard(cardId, ownerId)).resolves.toBe(true);
    expect((await ref.get()).exists).toBe(false);
    expect((await file.exists())[0]).toBe(false);
  });
});
