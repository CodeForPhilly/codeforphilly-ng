import { toast } from 'sonner';

/**
 * Clipboard write with a toast either way. `navigator.clipboard` is
 * undefined outside secure contexts, and reading `.writeText` off it throws
 * synchronously, so the guard sits outside the promise chain.
 */
export function copyWithToast(text: string, ok: string, fail: string): void {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (!clipboard) {
    toast.error(fail);
    return;
  }
  void clipboard
    .writeText(text)
    .then(() => toast.success(ok))
    .catch(() => toast.error(fail));
}
