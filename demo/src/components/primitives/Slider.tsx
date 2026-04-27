import * as RadixSlider from '@radix-ui/react-slider';
import { cn } from '@/lib/cn';

export function Slider({ className, ...props }: RadixSlider.SliderProps) {
  const value = (props.value ?? props.defaultValue ?? [0]) as number[];

  return (
    <RadixSlider.Root
      className={cn('relative flex h-5 w-full touch-none select-none items-center', className)}
      {...props}
    >
      <RadixSlider.Track className="relative h-1 grow overflow-hidden rounded-full bg-thread">
        <RadixSlider.Range className="absolute h-full bg-amber" />
      </RadixSlider.Track>
      {value.map((_, index) => (
        <RadixSlider.Thumb
          key={index}
          aria-label={`value-${index}`}
          className="block size-4 rounded-full border border-amber bg-raised shadow-sm transition-transform focus-visible:scale-110 focus-visible:outline-none"
        />
      ))}
    </RadixSlider.Root>
  );
}
