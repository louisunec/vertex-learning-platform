"use client";

import { useSyncExternalStore } from "react";
import { UserButton } from "@clerk/nextjs";

const subscribe = () => () => {};

/**
 * Clerk's user menu, rendered only once hydration is over. `UserButton` reads
 * Clerk's live `loaded` flag while rendering: the server never has Clerk
 * loaded, so when clerk-js finishes loading before React hydrates the header,
 * the client would render the menu's host element where the server rendered
 * nothing, and hydration fails.
 */
export function UserMenu() {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return hydrated ? <UserButton appearance={{ elements: { avatarBox: "size-12" } }} /> : null;
}
