import { MutagenError } from "../core/errors.js";

export const API_KEY_URL = "https://mutagen.ru/?api_config";
export const REFERRAL_URL = "https://mutagen.ru/?r=94674";
export const SUBSCRIPTION_URL = "https://mutagen.ru/serp/?tarif";
export const TOP_UP_URL = "https://mutagen.ru/?bill=on";

export const MISSING_KEY_RU = `Задайте MUTAGEN_API_KEY. Ключ: ${API_KEY_URL}. Регистрация: ${REFERRAL_URL} (партнёрская ссылка автора проекта).`;
export const MISSING_KEY_EN = `Set MUTAGEN_API_KEY. Get the key at ${API_KEY_URL}. Sign up: ${REFERRAL_URL} (the project author's referral link).`;

export function missingKeyError(): MutagenError {
  return new MutagenError({
    kind: "auth",
    retryable: false,
    message: "MUTAGEN_API_KEY is not set",
    hintRu: MISSING_KEY_RU,
    hintEn: MISSING_KEY_EN,
  });
}
