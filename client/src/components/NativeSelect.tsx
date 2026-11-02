import { Children, isValidElement, type ReactNode, type SelectHTMLAttributes } from 'react';

function optionText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? optionText(child.props.children)
        : String(child),
    )
    .join('');
}

function optionLabels(
  children: ReactNode,
  disabledGroup = false,
): { value: string; label: string; disabled: boolean }[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        label?: string;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type !== 'option')
      return optionLabels(child.props.children, disabledGroup || Boolean(child.props.disabled));
    const text = optionText(child.props.children);
    return [
      {
        value: String(child.props.value ?? text),
        label: child.props.label ?? text,
        disabled: disabledGroup || Boolean(child.props.disabled),
      },
    ];
  });
}

/** Keep the platform select's interaction while allowing its selected label to wrap. */
export function NativeSelect({
  children,
  className,
  style,
  onChange,
  reserveWidth = false,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'defaultValue' | 'multiple' | 'size'> & {
  value: string | number;
  reserveWidth?: boolean;
}) {
  const value = String(props.value);
  const options = optionLabels(children);
  const label =
    (options.find((option) => option.value === value) ?? options.find((option) => !option.disabled))
      ?.label ?? '';

  return (
    <span className={`native-select${className ? ` ${className}` : ''}`} style={style}>
      <select {...props} onChange={onChange}>
        {children}
      </select>
      <span className="native-select-value" aria-hidden="true">
        {label || '\u00a0'}
      </span>
      {reserveWidth &&
        options.map((option) => (
          <span className="native-select-size" aria-hidden="true" key={option.value}>
            {option.label}
          </span>
        ))}
    </span>
  );
}
