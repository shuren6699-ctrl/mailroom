import type { AccessIdentity } from "./access.ts";
import type { Principal } from "../inbox/permissions.ts";

export interface ApiVariables {
  accessIdentity: AccessIdentity;
  principal: Principal;
}
