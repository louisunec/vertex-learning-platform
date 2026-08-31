import { Icon, Navbar, type NavItem } from "@/components/ui";

const items: NavItem[] = [
  { label: "Courses", href: "/courses" },
  { label: "My Learning", href: "/my-learning" },
];

/** Learner app header: primary navigation plus notifications and the account avatar. */
export function SiteHeader() {
  return (
    <header className="border-b border-neutral-200">
      <div className="flex h-24 items-center justify-between px-6 md:px-12">
        <Navbar items={items} />
        <div className="flex items-center gap-4 sm:gap-6">
          <button
            type="button"
            aria-label="Notifications"
            className="hidden rounded-full p-1 text-neutral-900 transition-colors hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none sm:inline-flex"
          >
            <Icon name="bell" size={24} />
          </button>
          <span
            role="img"
            aria-label="Your account"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-neutral-500 ring-1 ring-neutral-300/60"
          >
            <Icon name="user" size={22} filled />
          </span>
        </div>
      </div>
    </header>
  );
}
