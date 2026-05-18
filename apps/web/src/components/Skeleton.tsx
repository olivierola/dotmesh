import clsx from 'clsx';

/**
 * Pure visual skeleton with shimmer animation (see index.css).
 *
 * Use the primitives below for common shapes:
 *   <Skeleton w="100%" h={24} />
 *   <SkeletonText lines={3} />
 *   <SkeletonCard />
 */

interface BaseProps {
  className?: string;
  w?: number | string;
  h?: number | string;
  rounded?: 'sm' | 'md' | 'lg' | 'full' | 'none';
}

const ROUNDED: Record<NonNullable<BaseProps['rounded']>, string> = {
  none: 'rounded-none',
  sm: 'rounded',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

export function Skeleton({ className, w, h, rounded = 'md' }: BaseProps) {
  return (
    <div
      className={clsx('skeleton', ROUNDED[rounded], className)}
      style={{
        width: typeof w === 'number' ? `${w}px` : w,
        height: typeof h === 'number' ? `${h}px` : h,
      }}
      aria-hidden
    />
  );
}

export function SkeletonText({
  lines = 3,
  lastWidth = '60%',
  className,
}: {
  lines?: number;
  lastWidth?: string;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          h={12}
          w={i === lines - 1 ? lastWidth : '100%'}
          rounded="sm"
        />
      ))}
    </div>
  );
}

/** Generic card skeleton: title row + 2 lines of text. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'rounded-md border border-neutral-800 bg-neutral-900/40 p-4',
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <Skeleton w="40%" h={10} rounded="sm" />
        <Skeleton w={40} h={10} rounded="sm" />
      </div>
      <SkeletonText lines={2} />
    </div>
  );
}

/** A list of N <SkeletonCard /> with consistent spacing. */
export function SkeletonList({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <ul className={clsx('flex flex-col gap-2', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <li key={i}>
          <SkeletonCard />
        </li>
      ))}
    </ul>
  );
}

/** Row variant for tighter rows (e.g. sidebar, recent items). */
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3',
        className,
      )}
    >
      <Skeleton w={28} h={28} rounded="full" />
      <div className="flex-1">
        <Skeleton w="50%" h={10} rounded="sm" />
        <Skeleton w="80%" h={8} rounded="sm" className="mt-1.5" />
      </div>
    </div>
  );
}

/** KPI card placeholder (dashboard). */
export function SkeletonKpi({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-neutral-800 bg-neutral-900/40 p-4',
        className,
      )}
    >
      <Skeleton w="60%" h={9} rounded="sm" />
      <Skeleton w="40%" h={22} rounded="sm" className="mt-2" />
      <Skeleton w="50%" h={8} rounded="sm" className="mt-2" />
    </div>
  );
}
