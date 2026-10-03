import { RefusedError } from "../errors.js";

// R5: an empty allowlist means "no restriction".

export class Allowlist<T extends string | number> {
  private readonly items: Set<T>;

  constructor(
    private readonly label: string,
    items: readonly T[],
  ) {
    this.items = new Set(items);
  }

  get restricted(): boolean {
    return this.items.size > 0;
  }

  allows(item: T): boolean {
    return !this.restricted || this.items.has(item);
  }

  assert(item: T): void {
    if (!this.allows(item)) {
      throw new RefusedError(`${this.label} ${item} is not in the configured allowlist`);
    }
  }

  filter<U>(list: U[], key: (u: U) => T): U[] {
    return list.filter((u) => this.allows(key(u)));
  }
}
