import '@angular/compiler';
import '../app-rules/globals';
import { it } from 'vitest';
Object.assign(globalThis, {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});
it('loads', async () => {
  const a = await import('../../../src/app/features/tasks/store/task-internal.effects');
  console.log('internal ok', Object.keys(a));
  const b =
    await import('../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.effects');
  console.log('repeat ok', Object.keys(b));
  const c =
    await import('../../../src/app/features/task-repeat-cfg/task-repeat-cfg.service');
  console.log('repeat svc ok', Object.keys(c));
  const d =
    await import('../../../src/app/features/add-tasks-for-tomorrow/add-tasks-for-tomorrow.service');
  console.log('tomorrow ok', Object.keys(d));
});
