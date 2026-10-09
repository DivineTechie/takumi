import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { describe, beforeAll, afterAll, beforeEach, it } from 'vitest';
import { doc, getDoc, setDoc, updateDoc, collection, getDocs } from 'firebase/firestore';

describe('Firestore Security Rules', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'takumi-rules-test',
      firestore: {
        rules: readFileSync(resolve(import.meta.dirname, '../../firestore.rules'), 'utf-8'),
        host: '127.0.0.1',
        port: 8085,
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

    // Setup base seed documents with security rules disabled (admin context)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      // Seed capture 1 owned by master-1
      await setDoc(doc(db, 'captures', 'cap_1'), {
        id: 'cap_1',
        master_uid: 'master-1',
        skill_title: 'Terminal block wiring',
        status: 'forging',
      });

      // Seed capture 2 owned by master-2
      await setDoc(doc(db, 'captures', 'cap_2'), {
        id: 'cap_2',
        master_uid: 'master-2',
        skill_title: 'Relay wiring',
        status: 'uploaded',
      });

      // Seed published skill linked to cap_1
      await setDoc(doc(db, 'skills', 'skill_published'), {
        id: 'skill_published',
        capture_id: 'cap_1',
        status: 'published',
        title: 'Published Skill',
      });

      // Seed draft skill
      await setDoc(doc(db, 'skills', 'skill_draft'), {
        id: 'skill_draft',
        capture_id: 'cap_1',
        status: 'draft',
        title: 'Draft Skill',
      });

      // Seed session for trainee-1
      await setDoc(doc(db, 'sessions', 'ses_1'), {
        id: 'ses_1',
        skill_id: 'skill_published',
        trainee_uid: 'trainee-1',
        status: 'live',
      });

      // Seed session event for ses_1
      await setDoc(doc(db, 'sessions', 'ses_1', 'events', 'evt_1'), {
        step: 1,
        type: 'step_done',
      });

      // Seed review_request
      await setDoc(doc(db, 'review_requests', 'rev_1'), {
        skill_id: 'skill_published',
        step: 2,
        reason: 'High mistake rate',
        status: 'open',
      });

      // Seed passport
      await setDoc(doc(db, 'passports', 'pass_1'), {
        trainee_uid: 'trainee-1',
        skill_id: 'skill_published',
        verify_url: 'https://takumi.dev/passports/pass_1',
      });
    });
  });

  it('trainee writing a session is denied (server only)', async () => {
    const traineeDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    await assertFails(
      setDoc(doc(traineeDb, 'sessions', 'ses_new'), {
        id: 'ses_new',
        skill_id: 'skill_published',
        trainee_uid: 'trainee-1',
        status: 'live',
      })
    );
  });

  it('trainee reading another trainee session is denied', async () => {
    const trainee2Db = testEnv.authenticatedContext('trainee-2', { role: 'trainee' }).firestore();
    await assertFails(getDoc(doc(trainee2Db, 'sessions', 'ses_1')));
    await assertFails(getDoc(doc(trainee2Db, 'sessions', 'ses_1', 'events', 'evt_1')));
  });

  it('trainee reading own session and events is allowed', async () => {
    const trainee1Db = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    await assertSucceeds(getDoc(doc(trainee1Db, 'sessions', 'ses_1')));
    await assertSucceeds(getDoc(doc(trainee1Db, 'sessions', 'ses_1', 'events', 'evt_1')));
  });

  it('trainee reading published skills is allowed', async () => {
    const trainee1Db = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    await assertSucceeds(getDoc(doc(trainee1Db, 'skills', 'skill_published')));
  });

  it('trainee reading draft skills is denied', async () => {
    const trainee1Db = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    await assertFails(getDoc(doc(trainee1Db, 'skills', 'skill_draft')));
  });

  it('master creating own capture is allowed', async () => {
    const masterDb = testEnv.authenticatedContext('master-1', { role: 'master' }).firestore();
    await assertSucceeds(
      setDoc(doc(masterDb, 'captures', 'cap_new'), {
        id: 'cap_new',
        master_uid: 'master-1',
        skill_title: 'New skill capture',
        status: 'recording',
      })
    );
  });

  it('master updating another master capture is denied', async () => {
    const master1Db = testEnv.authenticatedContext('master-1', { role: 'master' }).firestore();
    await assertFails(
      updateDoc(doc(master1Db, 'captures', 'cap_2'), {
        skill_title: 'Hacked title',
      })
    );
  });

  it('master updating a skill they own capture for is allowed', async () => {
    const master1Db = testEnv.authenticatedContext('master-1', { role: 'master' }).firestore();
    await assertSucceeds(
      updateDoc(doc(master1Db, 'skills', 'skill_published'), {
        title: 'Master updated title',
      })
    );
  });

  it('master updating a skill they do not own is denied', async () => {
    const master2Db = testEnv.authenticatedContext('master-2', { role: 'master' }).firestore();
    await assertFails(
      updateDoc(doc(master2Db, 'skills', 'skill_published'), {
        title: 'Master-2 unauthorized title update',
      })
    );
  });

  it('master changing a review_request field other than status is denied', async () => {
    const master1Db = testEnv.authenticatedContext('master-1', { role: 'master' }).firestore();
    await assertFails(
      updateDoc(doc(master1Db, 'review_requests', 'rev_1'), {
        reason: 'Changed reason maliciously',
      })
    );
  });

  it('master changing review_request status to applied is allowed', async () => {
    const master1Db = testEnv.authenticatedContext('master-1', { role: 'master' }).firestore();
    await assertSucceeds(
      updateDoc(doc(master1Db, 'review_requests', 'rev_1'), {
        status: 'applied',
      })
    );
  });

  it('supervisor reading all collections is allowed', async () => {
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();
    await assertSucceeds(getDoc(doc(supervisorDb, 'captures', 'cap_1')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'captures', 'cap_2')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'skills', 'skill_draft')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'sessions', 'ses_1')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'review_requests', 'rev_1')));
  });

  it('client reading or listing passports directly is denied', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthDb, 'passports', 'pass_1')));
    await assertFails(getDocs(collection(unauthDb, 'passports')));

    const traineeDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    await assertFails(getDoc(doc(traineeDb, 'passports', 'pass_1')));
    await assertFails(getDoc(doc(traineeDb, 'passport_locks', 'lock_1')));
  });

  it('signed-in user with no role can read published skills but not sessions', async () => {
    const noRoleDb = testEnv.authenticatedContext('user-plain').firestore();
    await assertSucceeds(getDoc(doc(noRoleDb, 'skills', 'skill_published')));
    await assertFails(getDoc(doc(noRoleDb, 'sessions', 'ses_1')));
  });

  it('products are readable by any signed-in user, writable only by supervisors', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'products', 'prod_1'), {
        id: 'prod_1',
        name: 'PCB 1',
      });
    });

    const traineeDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();
    const unauthDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(traineeDb, 'products', 'prod_1')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'products', 'prod_1')));
    await assertFails(getDoc(doc(unauthDb, 'products', 'prod_1')));

    await assertFails(setDoc(doc(traineeDb, 'products', 'prod_2'), { name: 'New' }));
    await assertSucceeds(setDoc(doc(supervisorDb, 'products', 'prod_2'), { name: 'New' }));
  });

  it('units are readable by supervisor or creator, server-written only', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'units', 'unit_1'), {
        id: 'unit_1',
        created_by: 'trainee-1',
        status: 'in_progress',
      });
    });

    const creatorDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    const otherDb = testEnv.authenticatedContext('trainee-2', { role: 'trainee' }).firestore();
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();

    await assertSucceeds(getDoc(doc(creatorDb, 'units', 'unit_1')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'units', 'unit_1')));
    await assertFails(getDoc(doc(otherDb, 'units', 'unit_1')));

    await assertFails(setDoc(doc(creatorDb, 'units', 'unit_2'), { status: 'in_progress' }));
    await assertFails(setDoc(doc(supervisorDb, 'units', 'unit_2'), { status: 'in_progress' }));
  });

  it('inspections are readable by supervisor or inspector, server-written only', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'inspections', 'insp_1'), {
        id: 'insp_1',
        inspector_uid: 'trainee-1',
        ai_verdict: 'ok',
      });
    });

    const inspectorDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    const otherDb = testEnv.authenticatedContext('trainee-2', { role: 'trainee' }).firestore();
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();

    await assertSucceeds(getDoc(doc(inspectorDb, 'inspections', 'insp_1')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'inspections', 'insp_1')));
    await assertFails(getDoc(doc(otherDb, 'inspections', 'insp_1')));

    await assertFails(setDoc(doc(inspectorDb, 'inspections', 'insp_2'), { ai_verdict: 'ok' }));
    await assertFails(setDoc(doc(supervisorDb, 'inspections', 'insp_2'), { ai_verdict: 'ok' }));
  });

  it('gallery collection is completely locked from direct client reads and writes', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'gallery', 'item_1'), {
        id: 'item_1',
        label: 'normal',
      });
    });

    const traineeDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();
    const unauthedDb = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(traineeDb, 'gallery', 'item_1')));
    await assertFails(getDoc(doc(supervisorDb, 'gallery', 'item_1')));
    await assertFails(getDoc(doc(unauthedDb, 'gallery', 'item_1')));

    await assertFails(setDoc(doc(traineeDb, 'gallery', 'item_2'), { label: 'normal' }));
    await assertFails(setDoc(doc(supervisorDb, 'gallery', 'item_2'), { label: 'normal' }));
  });

  it('machines are readable by signed-in users, direct writes fail', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'machines', 'mach_1'), {
        id: 'mach_1',
        name: 'Packaging Cell 1',
        created_by: 'user-1',
      });
    });

    const traineeDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();
    const unauthedDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(traineeDb, 'machines', 'mach_1')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'machines', 'mach_1')));
    await assertFails(getDoc(doc(unauthedDb, 'machines', 'mach_1')));

    await assertFails(setDoc(doc(traineeDb, 'machines', 'mach_2'), { name: 'Cell 2' }));
    await assertFails(setDoc(doc(supervisorDb, 'machines', 'mach_2'), { name: 'Cell 2' }));
  });

  it('machine_events are readable by supervisors only, direct writes fail', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'machine_events', 'ev_1'), {
        id: 'ev_1',
        machine_id: 'mach_1',
        event_type: 'state_change',
        state: 'running',
      });
    });

    const traineeDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();
    const unauthedDb = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(getDoc(doc(supervisorDb, 'machine_events', 'ev_1')));
    await assertFails(getDoc(doc(traineeDb, 'machine_events', 'ev_1')));
    await assertFails(getDoc(doc(unauthedDb, 'machine_events', 'ev_1')));

    await assertFails(setDoc(doc(supervisorDb, 'machine_events', 'ev_2'), { state: 'stopped' }));
  });

  it('soak_runs and soak_runs/{id}/truth are readable by creator or supervisor, direct writes fail', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'soak_runs', 'soak_1'), {
        id: 'soak_1',
        created_by: 'trainee-1',
        status: 'running',
      });
      await setDoc(doc(context.firestore(), 'soak_runs', 'soak_1', 'truth', 't_1'), {
        id: 't_1',
        state: 'running',
      });
    });

    const creatorDb = testEnv.authenticatedContext('trainee-1', { role: 'trainee' }).firestore();
    const otherDb = testEnv.authenticatedContext('trainee-2', { role: 'trainee' }).firestore();
    const supervisorDb = testEnv.authenticatedContext('sup-1', { role: 'supervisor' }).firestore();

    await assertSucceeds(getDoc(doc(creatorDb, 'soak_runs', 'soak_1')));
    await assertSucceeds(getDoc(doc(creatorDb, 'soak_runs', 'soak_1', 'truth', 't_1')));

    await assertSucceeds(getDoc(doc(supervisorDb, 'soak_runs', 'soak_1')));
    await assertSucceeds(getDoc(doc(supervisorDb, 'soak_runs', 'soak_1', 'truth', 't_1')));

    await assertFails(getDoc(doc(otherDb, 'soak_runs', 'soak_1')));
    await assertFails(getDoc(doc(otherDb, 'soak_runs', 'soak_1', 'truth', 't_1')));

    await assertFails(setDoc(doc(creatorDb, 'soak_runs', 'soak_2'), { status: 'running' }));
    await assertFails(setDoc(doc(creatorDb, 'soak_runs', 'soak_1', 'truth', 't_2'), { state: 'idle' }));
  });
});
