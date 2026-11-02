/** Reserve the space for every action state without duplicating accessible text. */
export function StableLabel({ current, labels }: { current: string; labels: readonly string[] }) {
  return (
    <span className="stable-label">
      <span>{current}</span>
      {labels.map((label) => (
        <span className="stable-label-size" aria-hidden="true" key={label}>
          {label}
        </span>
      ))}
    </span>
  );
}
