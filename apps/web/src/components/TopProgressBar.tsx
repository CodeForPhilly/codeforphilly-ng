import { useNavigation } from 'react-router';

/**
 * A thin progress bar shown at the top of the page during navigations.
 * Uses React Router's navigation state to show/hide.
 */
export function TopProgressBar() {
  const navigation = useNavigation();
  const isNavigating = navigation.state !== 'idle';

  return (
    <div
      role="progressbar"
      aria-label="Page loading"
      aria-valuenow={isNavigating ? 50 : 100}
      aria-valuemin={0}
      aria-valuemax={100}
      // The bar is only faded out when idle, not unmounted (the fade needs the
      // node to stay put). Hide it from AT meanwhile, or every page announces a
      // finished "Page loading" bar.
      aria-hidden={!isNavigating}
      className="fixed top-0 left-0 right-0 h-0.5 z-50 bg-primary transition-all duration-300"
      style={{
        opacity: isNavigating ? 1 : 0,
        transform: isNavigating ? 'scaleX(0.7)' : 'scaleX(1)',
        transformOrigin: 'left',
      }}
    />
  );
}
