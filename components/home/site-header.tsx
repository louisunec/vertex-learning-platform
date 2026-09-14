import { Show, SignInButton, SignUpButton } from "@clerk/nextjs";
import { Button, Icon, Navbar, type NavItem } from "@/components/ui";
import { UserMenu } from "./user-menu";

const items: NavItem[] = [
  { label: "Courses", href: "/courses" },
  { label: "My Learning", href: "/my-learning" },
];

/** Learner app header: primary navigation, notifications, and Clerk auth controls. */
export function SiteHeader() {
  return (
    <header className="border-b border-neutral-200">
      <div className="flex h-24 items-center justify-between px-6 md:px-12">
        <Navbar items={items} />
        <div className="flex items-center gap-4 sm:gap-6">
          <Show when="signed-in">
            <button
              type="button"
              aria-label="Notifications"
              className="hidden rounded-full p-1 text-neutral-900 transition-colors hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none sm:inline-flex"
            >
              <Icon name="bell" size={24} />
            </button>
            <UserMenu />
          </Show>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button variant="tertiary" size="md">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button size="md">Sign up</Button>
            </SignUpButton>
          </Show>
        </div>
      </div>
    </header>
  );
}
