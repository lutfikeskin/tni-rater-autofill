import crypto from 'node:crypto';

/**
 * Memory-safe container for sensitive credentials in Node.js runtimes.
 * Implements triple-pass cryptographic zeroization and TypeScript 5.2+ explicit resource management.
 */
export class SecureSecretBuffer implements Disposable {
  private buffer: Buffer | null;
  private readonly length: number;
  private isDisposed = false;

  constructor(secret: string | Uint8Array) {
    if (typeof secret === 'string') {
      const tempBuf = Buffer.from(secret, 'utf8');
      this.length = tempBuf.length;
      this.buffer = Buffer.allocUnsafe(this.length);
      tempBuf.copy(this.buffer);
      tempBuf.fill(0);
    } else {
      this.length = secret.length;
      this.buffer = Buffer.allocUnsafe(this.length);
      Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength).copy(this.buffer);
    }
  }

  public use<T>(action: (secretBytes: Uint8Array) => T): T {
    if (this.isDisposed || !this.buffer) {
      throw new Error('Access Violation: SecureSecretBuffer has already been zeroized.');
    }
    return action(new Uint8Array(this.buffer));
  }

  public zeroize(): void {
    if (this.isDisposed || !this.buffer) return;
    this.buffer.fill(0);
    crypto.randomFillSync(this.buffer);
    this.buffer.fill(0);
    this.buffer = null;
    this.isDisposed = true;
  }

  [Symbol.dispose](): void {
    this.zeroize();
  }
}