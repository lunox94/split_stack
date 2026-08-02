import { hashCanonicalHex } from "../domain/hashing";
import { RULES } from "./rules";

export const RULES_HASH = hashCanonicalHex(RULES);
