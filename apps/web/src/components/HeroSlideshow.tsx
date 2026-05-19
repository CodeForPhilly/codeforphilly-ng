import { useEffect, useState, type CSSProperties } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';

type Photo = { jpg: string; webp: string };
type PanVector = { fromX: number; fromY: number; toX: number; toY: number };

const VISIBLE_MS = 8000;
const CROSSFADE_MS = 1500;
const LAYER_LIFETIME_MS = CROSSFADE_MS + VISIBLE_MS + CROSSFADE_MS;
const PRELOAD_TIMEOUT_MS = 3000;
const PAN_RANGE_PCT = 2;

function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

function randomVector(): PanVector {
  const r = () => (Math.random() * 2 - 1) * PAN_RANGE_PCT;
  return { fromX: r(), fromY: r(), toX: r(), toY: r() };
}

function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    img.onload = done;
    img.onerror = done;
    img.src = url;
    setTimeout(done, PRELOAD_TIMEOUT_MS);
  });
}

interface PanLayerProps {
  photo: Photo;
  vector: PanVector;
  fadingIn: boolean;
  fadingOut: boolean;
  reducedMotion: boolean;
}

function PanLayer({ photo, vector, fadingIn, fadingOut, reducedMotion }: PanLayerProps) {
  const [appeared, setAppeared] = useState(!fadingIn);

  useEffect(() => {
    if (!fadingIn) return;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAppeared(true));
    });
    return () => cancelAnimationFrame(id);
  }, [fadingIn]);

  const opacity = fadingOut ? 0 : appeared ? 1 : 0;

  const style = {
    opacity,
    transition: `opacity ${CROSSFADE_MS}ms ease-in-out`,
    animation: reducedMotion ? 'none' : `hero-ken-burns ${LAYER_LIFETIME_MS}ms linear forwards`,
    transformOrigin: 'center center',
    willChange: 'transform, opacity',
    '--kb-from-x': `${vector.fromX}%`,
    '--kb-from-y': `${vector.fromY}%`,
    '--kb-to-x': `${vector.toX}%`,
    '--kb-to-y': `${vector.toY}%`,
  } as CSSProperties;

  return (
    <picture className="absolute inset-0 block" style={style}>
      <source srcSet={photo.webp} type="image/webp" />
      <img src={photo.jpg} alt="" className="w-full h-full object-cover" loading="eager" />
    </picture>
  );
}

interface HeroSlideshowProps {
  className?: string;
}

export function HeroSlideshow({ className }: HeroSlideshowProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [tick, setTick] = useState(0);
  const [currentVector, setCurrentVector] = useState<PanVector>(randomVector);
  const [nextVector, setNextVector] = useState<PanVector | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/hero/manifest.json')
      .then((r) => (r.ok ? (r.json() as Promise<Photo[]>) : []))
      .catch(() => [] as Photo[])
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data.length > 0) {
          setPhotos(shuffle(data));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (photos.length === 0) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const visibleTimer = setTimeout(() => {
      if (cancelled) return;
      const nextIdx = (tick + 1) % photos.length;
      const nextPhoto = photos[nextIdx];
      if (!nextPhoto) return;
      preload(nextPhoto.jpg).then(() => {
        if (cancelled) return;
        const v = randomVector();
        setNextVector(v);
        const settleTimer = setTimeout(() => {
          if (cancelled) return;
          setCurrentVector(v);
          setNextVector(null);
          setTick((prev) => prev + 1);
        }, CROSSFADE_MS);
        timers.push(settleTimer);
      });
    }, VISIBLE_MS);
    timers.push(visibleTimer);

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [photos, tick]);

  if (photos.length === 0) {
    return <div className={cn('absolute inset-0 bg-neutral-900', className)} aria-hidden="true" />;
  }

  const currentPhoto = photos[tick % photos.length];
  const nextPhoto = photos[(tick + 1) % photos.length];
  if (!currentPhoto || !nextPhoto) return null;

  const transitioning = nextVector !== null;

  return (
    <div className={cn('relative overflow-hidden', className)} aria-hidden="true">
      <PanLayer
        key={tick}
        photo={currentPhoto}
        vector={currentVector}
        fadingIn={false}
        fadingOut={transitioning}
        reducedMotion={reducedMotion}
      />
      {nextVector !== null && (
        <PanLayer
          key={tick + 1}
          photo={nextPhoto}
          vector={nextVector}
          fadingIn
          fadingOut={false}
          reducedMotion={reducedMotion}
        />
      )}
    </div>
  );
}
