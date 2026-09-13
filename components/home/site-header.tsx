import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { Button, Icon, Navbar, type NavItem } from "@/components/ui";

const items: NavItem[] = [
  { label: "Courses", href: "/courses" },
  { label: "My Learning", href: "/my-learning" },
];

/**
 * Learner app header: primary navigation, notifications, and Clerk auth controls.
 * `activeHref` highlights one primary item; pages whose design shows no active item omit it.
 * `returnTo` brings a learner who signs in or up here back to that page instead of
 * the global fallback (`/`).
 */
export function SiteHeader({ activeHref, returnTo }: { activeHref?: string; returnTo?: string } = {}) {
  return (
    <header className="border-b border-neutral-200">
      <div className="flex h-24 items-center justify-between px-6 md:px-12">
        <Navbar items={items.map((item) => ({ ...item, active: item.href === activeHref }))} />
        <div className="flex items-center gap-4 sm:gap-6">
          <Show when="signed-in">
            <button
              type="button"
              aria-label="Notifications"
              className="hidden rounded-full p-1 text-neutral-900 transition-colors hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none sm:inline-flex"
            >
              <Icon name="bell" size={24} />
            </button>
            <UserButton appearance={{ elements: { avatarBox: "size-12" } }} />
          </Show>
          <Show when="signed-out">
            <SignInButton mode="modal" forceRedirectUrl={returnTo} signUpForceRedirectUrl={returnTo}>
              <Button variant="tertiary" size="md">
                Sign in
              </Button>
            </SignInButton>
            {/* Below `sm` only Sign in fits; its modal links to sign-up. */}
            <span className="hidden sm:inline-flex">
              <SignUpButton mode="modal" forceRedirectUrl={returnTo} signInForceRedirectUrl={returnTo}>
                <Button size="md">Sign up</Button>
              </SignUpButton>
            </span>
          </Show>
        </div>
      </div>
    </header>
  );
}
