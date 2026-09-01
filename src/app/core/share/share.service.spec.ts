import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ShareService } from './share.service';
import { SnackService } from '../snack/snack.service';

/**
 * Regression guard for a copy that claimed success over an untouched clipboard.
 *
 * `navigator.clipboard` is absent on an insecure origin, so on a plain-HTTP
 * deployment every copy takes the `execCommand` fallback. That fallback reports
 * failure by RETURNING FALSE rather than throwing, and the old code discarded
 * the value — so the snack said "copied!" and the clipboard stayed empty, with
 * no error anywhere for the user to act on.
 */
describe('ShareService.copyToClipboard', () => {
  let service: ShareService;
  let snackSpy: jasmine.SpyObj<SnackService>;

  beforeEach(() => {
    snackSpy = jasmine.createSpyObj('SnackService', ['open']);
    TestBed.configureTestingModule({
      providers: [
        ShareService,
        { provide: SnackService, useValue: snackSpy },
        { provide: MatDialog, useValue: {} },
      ],
    });
    service = TestBed.inject(ShareService);
  });

  /**
   * `navigator.clipboard` is an accessor on Navigator.prototype, not an own
   * property, so `spyOnProperty(navigator, ...)` cannot see it. Defining an own
   * property shadows the prototype for the duration of a test; deleting it in
   * afterEach uncovers the real one again.
   */
  const setClipboard = (value: unknown): void => {
    Object.defineProperty(navigator, 'clipboard', {
      value,
      configurable: true,
      writable: true,
    });
  };

  /** What an insecure origin looks like from script. */
  const denyAsyncClipboard = (): void => setClipboard(undefined);

  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('reports failure when the fallback cannot copy', async () => {
    denyAsyncClipboard();
    spyOn(document, 'execCommand').and.returnValue(false);

    const result = await service.copyToClipboard('spk_1_abc', 'Key');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to copy to clipboard');
  });

  it('does NOT claim "copied" when the fallback failed', async () => {
    denyAsyncClipboard();
    spyOn(document, 'execCommand').and.returnValue(false);

    await service.copyToClipboard('spk_1_abc', 'Key');

    expect(snackSpy.open).not.toHaveBeenCalled();
  });

  it('succeeds and notifies when the fallback copies', async () => {
    denyAsyncClipboard();
    spyOn(document, 'execCommand').and.returnValue(true);

    const result = await service.copyToClipboard('spk_1_abc', 'Key');

    expect(result.success).toBe(true);
    expect(snackSpy.open).toHaveBeenCalledWith('Key copied to clipboard!');
  });

  it('reports failure when execCommand throws', async () => {
    denyAsyncClipboard();
    spyOn(document, 'execCommand').and.throwError('blocked');

    const result = await service.copyToClipboard('spk_1_abc', 'Key');

    expect(result.success).toBe(false);
  });

  it('leaves no textarea behind, on success or failure', async () => {
    denyAsyncClipboard();
    spyOn(document, 'execCommand').and.returnValue(false);
    const before = document.body.querySelectorAll('textarea').length;

    await service.copyToClipboard('spk_1_abc', 'Key');

    expect(document.body.querySelectorAll('textarea').length).toBe(before);
  });

  it('keeps the fallback textarea in the viewport and focused (Firefox)', async () => {
    denyAsyncClipboard();
    let seen: { opacity: string; left: string; focused: boolean } | null = null;
    spyOn(document, 'execCommand').and.callFake(() => {
      const el = document.body.querySelector('textarea');
      seen = {
        opacity: el?.style.opacity ?? '',
        left: el?.style.left ?? '',
        focused: document.activeElement === el,
      };
      return true;
    });

    await service.copyToClipboard('spk_1_abc', 'Key');

    // Firefox refuses to copy a selection from an element parked off-screen,
    // and needs it focused before select() takes effect.
    expect(seen!.opacity).toBe('0');
    expect(seen!.left).toBe('0px');
    expect(seen!.focused).toBe(true);
  });

  it('uses the async Clipboard API when the origin allows it', async () => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    setClipboard({ writeText });
    const exec = spyOn(document, 'execCommand');

    const result = await service.copyToClipboard('spk_1_abc', 'Key');

    expect(writeText).toHaveBeenCalledWith('spk_1_abc');
    expect(exec).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
