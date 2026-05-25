import { LiveData } from '@toeverything/infra';

/**
 * Lightweight reactive wrapper around navigator.onLine.
 */
export class NetworkMonitor {
  readonly online$ = new LiveData<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  private readonly handleOnline = () => this.online$.next(true);
  private readonly handleOffline = () => this.online$.next(false);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
    }
  }

  get isOnline(): boolean {
    return this.online$.value;
  }

  setOnline(online: boolean): void {
    this.online$.next(online);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
    }
  }
}
