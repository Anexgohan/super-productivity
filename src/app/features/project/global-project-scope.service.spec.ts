import { TestBed } from '@angular/core/testing';
import { GlobalProjectScopeService } from './global-project-scope.service';
import { LS } from '../../core/persistence/storage-keys.const';

describe('GlobalProjectScopeService', () => {
  const make = (): GlobalProjectScopeService => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(GlobalProjectScopeService);
  };

  afterEach(() => {
    localStorage.removeItem(LS.GLOBAL_PROJECT_SCOPE);
  });

  it('defaults to All Projects when nothing is stored', () => {
    localStorage.removeItem(LS.GLOBAL_PROJECT_SCOPE);
    const service = make();
    expect(service.scope()).toBe('');
    expect(service.isAll()).toBe(true);
  });

  it('adopts a persisted scope on construction', () => {
    localStorage.setItem(LS.GLOBAL_PROJECT_SCOPE, 'P1');
    const service = make();
    expect(service.scope()).toBe('P1');
    expect(service.isAll()).toBe(false);
  });

  it('persists a new scope', () => {
    const service = make();
    service.setScope('P2');
    expect(service.scope()).toBe('P2');
    expect(localStorage.getItem(LS.GLOBAL_PROJECT_SCOPE)).toBe('P2');
  });

  it('returns to All Projects when cleared', () => {
    localStorage.setItem(LS.GLOBAL_PROJECT_SCOPE, 'P1');
    const service = make();
    service.setScope('');
    expect(service.isAll()).toBe(true);
    expect(localStorage.getItem(LS.GLOBAL_PROJECT_SCOPE)).toBe('');
  });

  it('falls back to All Projects when localStorage cannot be read', () => {
    const spy = spyOn(Storage.prototype, 'getItem').and.throwError('denied');
    const service = make();
    expect(service.scope()).toBe('');
    spy.and.callThrough();
  });

  it('keeps the in-memory scope when localStorage cannot be written', () => {
    const service = make();
    const spy = spyOn(Storage.prototype, 'setItem').and.throwError('quota');
    expect(() => service.setScope('P3')).not.toThrow();
    expect(service.scope()).toBe('P3');
    spy.and.callThrough();
  });
});
