import React from 'react';
import PropTypes from 'prop-types';
import { cx } from './classNames';

/**
 * Inline - horizontal layout helper with tokenized gaps.
 */
export default function Inline({
  as: Comp = 'div',
  gap = 'default',
  align = 'center',
  wrap = true,
  className,
  children,
  style,
  ...rest
}) {
  const gapClass =
    gap === 'compact'
      ? 'gap-compact'
      : gap === 'cozy'
        ? 'gap-cozy'
        : gap === 'relaxed'
          ? 'gap-relaxed'
          : gap === 'spacious'
            ? 'gap-spacious'
            : 'gap-default';
  const gapValue =
    gap === 'compact'
      ? 'var(--spacing-compact)'
      : gap === 'cozy'
        ? 'var(--spacing-cozy)'
        : gap === 'relaxed'
          ? 'var(--spacing-relaxed)'
          : gap === 'spacious'
            ? 'var(--spacing-spacious)'
            : 'var(--spacing-default)';

  const alignClass =
    align === 'start' ? 'items-start' : align === 'end' ? 'items-end' : 'items-center';
  const mergedStyle = {
    ...style,
    gap: style?.gap ?? gapValue
  };

  return (
    <Comp
      className={cx('flex', alignClass, wrap ? 'flex-wrap' : 'flex-nowrap', gapClass, className)}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </Comp>
  );
}

Inline.propTypes = {
  as: PropTypes.elementType,
  gap: PropTypes.oneOf(['compact', 'cozy', 'default', 'relaxed', 'spacious']),
  align: PropTypes.oneOf(['start', 'center', 'end']),
  wrap: PropTypes.bool,
  className: PropTypes.string,
  style: PropTypes.object,
  children: PropTypes.node
};
