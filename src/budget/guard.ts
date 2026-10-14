import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { validationError } from "../core/errors.js";
import { requirePositive } from "../core/validate.js";
import { type Estimate, formatRub } from "./estimate.js";
import { isPaidMethod, toKopecks } from "./pricing.js";

export type BudgetErrorKind =
  | "free_only"
  | "over_budget"
  | "over_allowance"
  | "needs_confirmation"
  | "low_balance";

export interface BudgetErrorInit {
  kind: BudgetErrorKind;
  message: string;
  hintRu: string;
  hintEn: string;
  estimate: Estimate;
  confirmToken?: string;
  tokenExpiresAt?: string;
  remainingRub?: number;
  balanceRub?: number;
}

export class BudgetError extends Error {
  override readonly name = "BudgetError";
  readonly kind: BudgetErrorKind;
  readonly hintRu: string;
  readonly hintEn: string;
  readonly estimate: Estimate;
  readonly confirmToken: string | undefined;
  readonly tokenExpiresAt: string | undefined;
  readonly remainingRub: number | undefined;
  readonly balanceRub: number | undefined;

  constructor(init: BudgetErrorInit) {
    super(init.message);
    this.kind = init.kind;
    this.hintRu = init.hintRu;
    this.hintEn = init.hintEn;
    this.estimate = init.estimate;
    this.confirmToken = init.confirmToken;
    this.tokenExpiresAt = init.tokenExpiresAt;
    this.remainingRub = init.remainingRub;
    this.balanceRub = init.balanceRub;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      hintRu: this.hintRu,
      hintEn: this.hintEn,
      estimate: this.estimate,
      confirmToken: this.confirmToken,
      tokenExpiresAt: this.tokenExpiresAt,
      remainingRub: this.remainingRub,
      balanceRub: this.balanceRub,
    };
  }
}

export function isBudgetError(value: unknown): value is BudgetError {
  return value instanceof BudgetError;
}

export interface SpendGuardOptions {
  budgetRub?: number;
  autoApproveRub?: number;
  freeOnly?: boolean;
  balanceCheckAboveRub?: number;
  tokenTtlMs?: number;
  balance?: () => Promise<number>;
  now?: () => number;
}

export const DEFAULT_GUARD = Object.freeze({
  budgetRub: 50,
  autoApproveRub: 1,
  balanceCheckAboveRub: 5,
  tokenTtlMs: 10 * 60_000,
});

export type SpendStatus = "ok" | "failed";

export interface SpendRecord {
  ts: string;
  label: string;
  estimateRub: number;
  spentRub: number;
  quotaRequests: number;
  status: SpendStatus;
}

export interface Spending {
  budgetRub: number;
  spentRub: number;
  reservedRub: number;
  remainingRub: number;
  freeOnly: boolean;
  quotaRequests: number;
  calls: SpendRecord[];
}

export interface AuthorizeRequest {
  label: string;
  planHash: string;
  estimate: Estimate;
  confirmToken?: string | undefined;
}

export class Reservation {
  readonly label: string;
  readonly estimate: Estimate;
  #remaining: number;
  #spent = 0;
  #extraQuota = 0;
  #closed = false;
  #overrun = 0;
  readonly #reasons = new Set<string>();
  readonly #baseQuota: number;
  readonly #onCharge: (fromReserve: number, total: number, reason: string | undefined) => void;
  readonly #onClose: (reservation: Reservation, unused: number, status: SpendStatus) => void;

  constructor(
    label: string,
    estimate: Estimate,
    onCharge: (fromReserve: number, total: number, reason: string | undefined) => void,
    onClose: (reservation: Reservation, unused: number, status: SpendStatus) => void,
    baseQuota = estimate.quotaRequests,
  ) {
    this.label = label;
    this.estimate = estimate;
    this.#remaining = estimate.totalKopecks;
    this.#baseQuota = baseQuota;
    this.#onCharge = onCharge;
    this.#onClose = onClose;
  }

  get spentKopecks(): number {
    return this.#spent;
  }

  get remainingKopecks(): number {
    return this.#remaining;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get quotaRequests(): number {
    return this.#baseQuota + this.#extraQuota;
  }

  addQuota(requests: number): void {
    if (!this.#closed && requests > 0) this.#extraQuota += requests;
  }

  get overrunKopecks(): number {
    return this.#overrun;
  }

  /** `reason` explains a charge the estimate may not cover; it is reported on an overrun. */
  charge(kopecks: number, reason?: string): void {
    if (this.#closed || kopecks <= 0) return;
    const fromReserve = Math.min(kopecks, this.#remaining);
    this.#remaining -= fromReserve;
    this.#spent += kopecks;
    if (fromReserve < kopecks) {
      this.#overrun += kopecks - fromReserve;
      this.#reasons.add(reason ?? "списание сверх сметы / a charge beyond the estimate");
    }
    this.#onCharge(fromReserve, kopecks, reason);
  }

  /** The warning about spending beyond the estimate, if there was any. */
  overrunWarning(): string | undefined {
    if (this.#overrun === 0) return undefined;
    const sum = formatRub(this.#overrun);
    const reasons = [...this.#reasons].join("; ");
    return `${this.label}: фактическая трата превысила смету на ${sum} ₽, причина: ${reasons}. Actual spending exceeded the estimate by ${sum} RUB.`;
  }

  close(status: SpendStatus = "ok"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose(this, this.#remaining, status);
    this.#remaining = 0;
  }
}

function paidMethods(estimate: Estimate): string {
  return [
    ...new Set(
      estimate.items
        .filter(
          (item) =>
            isPaidMethod(item.method) &&
            (item.method === "parser.get" ? item.billableUnits : item.units) > 0,
        )
        .map((item) => item.method),
    ),
  ].join(", ");
}

function freeOnlyError(label: string, estimate: Estimate, paid: string): BudgetError {
  const cost = estimate.totalKopecks;
  return new BudgetError({
    kind: "free_only",
    estimate,
    message: `Paid call refused in free-only mode: ${label} uses ${paid} (estimate ${formatRub(cost)} RUB)`,
    hintRu: `Включен режим «только бесплатное» (MUTAGEN_FREE_ONLY=1), а ${label} вызывает платный метод ${paid} (смета ${formatRub(cost)} ₽). Запрос к API не отправлялся. Отключите режим, чтобы выполнить платный вызов.`,
    hintEn: `Free-only mode is on (MUTAGEN_FREE_ONLY=1) and ${label} calls the paid method ${paid} (estimate ${formatRub(cost)} RUB). Nothing was sent to the API. Turn the mode off to run paid calls.`,
  });
}

/**
 * An approved plan: nested calls reserve their estimates from it without their own
 * confirmation, but never beyond what is left of it.
 */
export class Allowance {
  readonly label: string;
  readonly estimate: Estimate;
  readonly #parent: Reservation;
  readonly #freeOnly: boolean;
  #committed = 0;

  constructor(parent: Reservation, freeOnly: boolean) {
    this.label = parent.label;
    this.estimate = parent.estimate;
    this.#parent = parent;
    this.#freeOnly = freeOnly;
  }

  get spentKopecks(): number {
    return this.#parent.spentKopecks;
  }

  get remainingKopecks(): number {
    return Math.max(0, this.#parent.remainingKopecks - this.#committed);
  }

  get closed(): boolean {
    return this.#parent.closed;
  }

  overrunWarning(): string | undefined {
    return this.#parent.overrunWarning();
  }

  reserve(label: string, estimate: Estimate): Reservation {
    const paid = paidMethods(estimate);
    if (paid !== "" && this.#freeOnly) throw freeOnlyError(label, estimate, paid);
    const cost = estimate.totalKopecks;
    const left = this.closed ? 0 : this.remainingKopecks;
    if (cost > left) {
      const plan = formatRub(this.estimate.totalKopecks);
      throw new BudgetError({
        kind: "over_allowance",
        estimate,
        remainingRub: left / 100,
        message: `${label} (${formatRub(cost)} RUB) exceeds what is left of the approved plan ${this.label}: ${formatRub(left)} of ${plan} RUB`,
        hintRu: `${label} стоит ${formatRub(cost)} ₽, а от одобренной сметы ${this.label} (${plan} ₽) осталось ${formatRub(left)} ₽. Вызов не выполнялся, результат частичный.`,
        hintEn: `${label} costs ${formatRub(cost)} RUB and only ${formatRub(left)} RUB is left of the approved plan ${this.label} (${plan} RUB). The call was skipped, the result is partial.`,
      });
    }
    this.#committed += cost;
    return new Reservation(
      label,
      estimate,
      (fromReserve, total, reason) => {
        this.#committed -= fromReserve;
        this.#parent.charge(total, reason);
      },
      (reservation, unused) => {
        this.#committed -= unused;
        this.#parent.addQuota(reservation.quotaRequests);
      },
    );
  }

  close(status: SpendStatus = "ok"): void {
    this.#parent.close(status);
  }
}

function amount(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw validationError(
      `Invalid ${name}: ${value}`,
      `Неверная настройка ${name}: ${value}. Нужна неотрицательная сумма в рублях.`,
      `Invalid ${name}: ${value}. Expected a non-negative amount in RUB.`,
    );
  }
  return toKopecks(Math.round(value * 100) / 100, name);
}

export class SpendGuard {
  readonly budgetKopecks: number;
  readonly autoApproveKopecks: number;
  readonly balanceCheckKopecks: number;
  readonly freeOnly: boolean;
  readonly tokenTtlMs: number;
  readonly #salt = randomBytes(32);
  readonly #usedNonces = new Set<string>();
  readonly #balance: (() => Promise<number>) | undefined;
  readonly #now: () => number;
  #spent = 0;
  #reserved = 0;
  #calls: SpendRecord[] = [];

  constructor(options: SpendGuardOptions = {}) {
    this.budgetKopecks = amount("budgetRub", options.budgetRub ?? DEFAULT_GUARD.budgetRub);
    this.autoApproveKopecks = amount(
      "autoApproveRub",
      options.autoApproveRub ?? DEFAULT_GUARD.autoApproveRub,
    );
    this.balanceCheckKopecks = amount(
      "balanceCheckAboveRub",
      options.balanceCheckAboveRub ?? DEFAULT_GUARD.balanceCheckAboveRub,
    );
    this.freeOnly = options.freeOnly ?? false;
    this.tokenTtlMs = requirePositive("tokenTtlMs", options.tokenTtlMs ?? DEFAULT_GUARD.tokenTtlMs);
    this.#balance = options.balance;
    this.#now = options.now ?? Date.now;
  }

  get remainingKopecks(): number {
    return Math.max(0, this.budgetKopecks - this.#spent - this.#reserved);
  }

  spending(): Spending {
    return {
      budgetRub: this.budgetKopecks / 100,
      spentRub: this.#spent / 100,
      reservedRub: this.#reserved / 100,
      remainingRub: this.remainingKopecks / 100,
      freeOnly: this.freeOnly,
      quotaRequests: this.#calls.reduce((sum, call) => sum + call.quotaRequests, 0),
      calls: this.#calls.map((call) => ({ ...call })),
    };
  }

  async authorize(request: AuthorizeRequest): Promise<Reservation> {
    await this.#admit(request);
    return this.#open(request.label, request.estimate, request.estimate.quotaRequests);
  }

  /** Approves a whole plan once; see {@link Allowance}. Quota is counted by the nested calls. */
  async allow(request: AuthorizeRequest): Promise<Allowance> {
    await this.#admit(request);
    return new Allowance(this.#open(request.label, request.estimate, 0), this.freeOnly);
  }

  async #admit(request: AuthorizeRequest): Promise<void> {
    const { estimate } = request;
    const cost = estimate.totalKopecks;
    const paid = paidMethods(estimate);
    if (paid !== "" && this.freeOnly) throw freeOnlyError(request.label, estimate, paid);
    this.#checkBudget(request);
    let nonce: string | undefined;
    if (cost > this.autoApproveKopecks || estimate.unconfirmedPrices) {
      nonce = this.#verifyToken(request);
      if (nonce === undefined) throw this.#confirmationError(request);
    }
    if (cost > this.balanceCheckKopecks && this.#balance) {
      const balanceKopecks = Math.floor((await this.#balance()) * 100 + 1e-6);
      const reserved = this.#reserved;
      if (balanceKopecks < cost + reserved) {
        const busyRu =
          reserved > 0 ? ` и еще ${formatRub(reserved)} ₽ зарезервировано идущими вызовами` : "";
        const busyEn =
          reserved > 0 ? ` plus ${formatRub(reserved)} RUB reserved by running calls` : "";
        throw new BudgetError({
          kind: "low_balance",
          estimate,
          balanceRub: balanceKopecks / 100,
          message: `Mutagen balance ${formatRub(balanceKopecks)} RUB is below the estimate ${formatRub(cost)} RUB${busyEn}`,
          hintRu: `На балансе Мутагена ${formatRub(balanceKopecks)} ₽, а смета ${formatRub(cost)} ₽${busyRu}. Пополните баланс: https://mutagen.ru/?bill=on`,
          hintEn: `The Mutagen balance is ${formatRub(balanceKopecks)} RUB and the estimate is ${formatRub(cost)} RUB${busyEn}. Top up at https://mutagen.ru/?bill=on`,
        });
      }
      this.#checkBudget(request);
    }
    if (nonce !== undefined) {
      if (this.#usedNonces.has(nonce)) throw this.#confirmationError(request);
      this.#usedNonces.add(nonce);
    }
  }

  #open(label: string, estimate: Estimate, baseQuota: number): Reservation {
    this.#reserved += estimate.totalKopecks;
    return new Reservation(
      label,
      estimate,
      (fromReserve, total) => {
        this.#reserved -= fromReserve;
        this.#spent += total;
      },
      (reservation, unused, status) => {
        this.#reserved -= unused;
        this.#calls.push({
          ts: new Date(this.#now()).toISOString(),
          label: reservation.label,
          estimateRub: reservation.estimate.totalRub,
          spentRub: reservation.spentKopecks / 100,
          quotaRequests: reservation.quotaRequests,
          status,
        });
      },
      baseQuota,
    );
  }

  #checkBudget(request: AuthorizeRequest): void {
    const cost = request.estimate.totalKopecks;
    const remaining = this.remainingKopecks;
    if (cost <= remaining) return;
    throw new BudgetError({
      kind: "over_budget",
      estimate: request.estimate,
      remainingRub: remaining / 100,
      message: `Estimate ${formatRub(cost)} RUB exceeds the remaining session budget ${formatRub(remaining)} RUB`,
      hintRu: `Смета ${formatRub(cost)} ₽ больше остатка бюджета сессии ${formatRub(remaining)} ₽ (лимит ${formatRub(this.budgetKopecks)} ₽, MUTAGEN_BUDGET_RUB). Сократите список фраз или видов частотности либо увеличьте бюджет.`,
      hintEn: `The estimate of ${formatRub(cost)} RUB exceeds the remaining session budget of ${formatRub(remaining)} RUB (limit ${formatRub(this.budgetKopecks)} RUB, MUTAGEN_BUDGET_RUB). Reduce the phrases or match types, or raise the budget.`,
    });
  }

  #sign(planHash: string, cost: number, nonce: string, expiresAt: number): Buffer {
    return createHmac("sha256", this.#salt)
      .update(`${planHash}\n${cost}\n${nonce}\n${expiresAt}`)
      .digest();
  }

  #issueToken(planHash: string, cost: number, expiresAt: number): string {
    const nonce = randomBytes(12).toString("base64url");
    const signature = this.#sign(planHash, cost, nonce, expiresAt).toString("base64url");
    return `${nonce}.${expiresAt.toString(36)}.${signature}`;
  }

  #verifyToken(request: AuthorizeRequest): string | undefined {
    const parts = request.confirmToken?.split(".") ?? [];
    if (parts.length !== 3) return undefined;
    const [nonce = "", expiry = "", signature = ""] = parts;
    const expiresAt = Number.parseInt(expiry, 36);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) return undefined;
    if (this.#usedNonces.has(nonce)) return undefined;
    const expected = this.#sign(request.planHash, request.estimate.totalKopecks, nonce, expiresAt);
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return nonce;
  }

  #confirmationError(request: AuthorizeRequest): BudgetError {
    const { estimate, label } = request;
    const cost = estimate.totalKopecks;
    const expiresAt = this.#now() + this.tokenTtlMs;
    const confirmToken = this.#issueToken(request.planHash, cost, expiresAt);
    const minutes = Math.max(1, Math.round(this.tokenTtlMs / 60_000));
    const overLimit = cost > this.autoApproveKopecks;
    const reasonRu = overLimit
      ? `${label} стоит ${formatRub(cost)} ₽ — больше порога автоподтверждения ${formatRub(this.autoApproveKopecks)} ₽ (MUTAGEN_AUTO_APPROVE_RUB).`
      : `${label} стоит ${formatRub(cost)} ₽.`;
    const reasonEn = overLimit
      ? `${label} costs ${formatRub(cost)} RUB, above the auto-approve limit of ${formatRub(this.autoApproveKopecks)} RUB (MUTAGEN_AUTO_APPROVE_RUB).`
      : `${label} costs ${formatRub(cost)} RUB.`;
    const unconfirmedRu = estimate.unconfirmedPrices
      ? " Цена не подтверждена, поэтому вызов всегда требует подтверждения."
      : "";
    const unconfirmedEn = estimate.unconfirmedPrices
      ? " The price is not confirmed, so the call always needs confirmation."
      : "";
    const invalid = request.confirmToken
      ? " The given token is invalid, expired, already used or belongs to another plan."
      : "";
    const invalidRu = request.confirmToken
      ? " Переданный токен не подошел: он неверный, истек, уже использован или выдан для другого плана."
      : "";
    return new BudgetError({
      kind: "needs_confirmation",
      estimate,
      confirmToken,
      tokenExpiresAt: new Date(expiresAt).toISOString(),
      message: `Confirmation required: ${label} costs ${formatRub(cost)} RUB.${invalid}`,
      hintRu: `${reasonRu}${unconfirmedRu}${invalidRu} Чтобы запустить, повторите тот же вызов с confirm_token в течение ${minutes} мин.`,
      hintEn: `${reasonEn}${unconfirmedEn}${invalid} To run it, repeat the same call with confirm_token within ${minutes} min.`,
    });
  }
}
