import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { describe, beforeAll, afterAll, beforeEach, it } from 'vitest';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';

describe('Storage Security Rules', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'takumi-rules-test',
      firestore: {
        rules: readFileSync(resolve(import.meta.dirname, '../../firestore.rules'), 'utf-8'),
        host: '127.0.0.1',
        port: 8085,
      },
      storage: {
        rules: readFileSync(resolve(import.meta.dirname, '../../storage.rules'), 'utf-8'),
        host: '127.0.0.1',
        port: 9199,
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.clearStorage();

    // Seed capture doc in Firestore so storage rule firestore.get() finds master_uid
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'captures', 'cap_1'), {
        id: 'cap_1',
        master_uid: 'master-1',
        skill_title: 'Terminal wiring',
      });
      await setDoc(doc(db, 'captures', 'cap_2'), {
        id: 'cap_2',
        master_uid: 'master-2',
        skill_title: 'Relay wiring',
      });
    });
  });

  it('master uploading to their own captures/{id} is allowed', async () => {
    const master1Storage = testEnv.authenticatedContext('master-1', { role: 'master' }).storage();
    const fileRef = ref(master1Storage, 'captures/cap_1/video.webm');
    await assertSucceeds(uploadBytes(fileRef, new Uint8Array([1, 2, 3])));
  });

  it('another master uploading to captures/{id} is denied', async () => {
    const master2Storage = testEnv.authenticatedContext('master-2', { role: 'master' }).storage();
    const fileRef = ref(master2Storage, 'captures/cap_1/video.webm');
    await assertFails(uploadBytes(fileRef, new Uint8Array([1, 2, 3])));
  });

  it('any client writing to skills/ is denied', async () => {
    const master1Storage = testEnv.authenticatedContext('master-1', { role: 'master' }).storage();
    const skillRef = ref(master1Storage, 'skills/skill_1/card.png');
    await assertFails(uploadBytes(skillRef, new Uint8Array([1, 2, 3])));

    const traineeStorage = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).storage();
    const skillRefTrainee = ref(traineeStorage, 'skills/skill_1/card.png');
    await assertFails(uploadBytes(skillRefTrainee, new Uint8Array([1, 2, 3])));
  });

  it('unauthenticated read of skills/ is denied', async () => {
    const unauthStorage = testEnv.unauthenticatedContext().storage();
    const skillRef = ref(unauthStorage, 'skills/skill_1/card.png');
    await assertFails(getBytes(skillRef));
  });

  it('authenticated user read of skills/ is allowed', async () => {
    // Seed a skill file with security rules disabled
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const storage = context.storage();
      const seedRef = ref(storage, 'skills/skill_1/card.png');
      await uploadBytes(seedRef, new Uint8Array([1, 2, 3]));
    });

    const traineeStorage = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).storage();
    const skillRef = ref(traineeStorage, 'skills/skill_1/card.png');
    await assertSucceeds(getBytes(skillRef));
  });

  it('any client read or write to sessions/** is denied (server serves via signed URLs)', async () => {
    // Seed a frame file with security rules disabled
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const storage = context.storage();
      const frameRef = ref(storage, 'sessions/ses_123/frames/evt_1.jpg');
      await uploadBytes(frameRef, new Uint8Array([1, 2, 3]));
    });

    const unauthStorage = testEnv.unauthenticatedContext().storage();
    const unauthRef = ref(unauthStorage, 'sessions/ses_123/frames/evt_1.jpg');
    await assertFails(getBytes(unauthRef));
    await assertFails(uploadBytes(unauthRef, new Uint8Array([1, 2, 3])));

    const traineeStorage = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).storage();
    const traineeRef = ref(traineeStorage, 'sessions/ses_123/frames/evt_1.jpg');
    await assertFails(getBytes(traineeRef));
    await assertFails(uploadBytes(traineeRef, new Uint8Array([1, 2, 3])));

    const supervisorStorage = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).storage();
    const supRef = ref(supervisorStorage, 'sessions/ses_123/frames/evt_1.jpg');
    await assertFails(getBytes(supRef));
    await assertFails(uploadBytes(supRef, new Uint8Array([1, 2, 3])));
  });
});
