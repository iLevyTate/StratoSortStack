import React from 'react';
import PropTypes from 'prop-types';
import { cx } from './classNames';

/**
 * Stack - vertical layout helper with tokenized gaps.
 */
export default function Stack({
  as: Comp = 'div',
  gap = 'default',
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
  const mergedStyle = {
    ...style,
    gap: style?.gap ?? gapValue
  };

  return (
    <Comp className={cx('flex flex-col', gapClass, className)} style={mergedStyle} {...rest}>
      {children}
    </Comp>
  );
}

Stack.propTypes = {
  as: PropTypes.elementType,
  gap: PropTypes.oneOf(['compact', 'cozy', 'default', 'relaxed', 'spacious']),
  className: PropTypes.string,
  style: PropTypes.object,
  children: PropTypes.node
};
