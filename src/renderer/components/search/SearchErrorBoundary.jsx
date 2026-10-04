import React, { useRef } from 'react';
import PropTypes from 'prop-types';
import { logger } from '../../../shared/logger';
import { useDialogFocusTrap } from '../../hooks';
import Button from '../ui/Button';
import { Heading, Text } from '../ui/Typography';

// Function-component fallback so the dialog focus-trap hook can be used from
// the class-based boundary below.
function SearchErrorFallback({ error = null, onRetry, onClose }) {
  const dialogRef = useRef(null);
  useDialogFocusTrap({ active: true, containerRef: dialogRef, onEscape: onClose });

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="search-error-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'var(--overlay-scrim)' }}
    >
      <div className="mx-4 w-full max-w-md rounded-lg border border-border-soft bg-system-gray-100 shadow-xl">
        <div className="p-6">
          <div className="flex flex-col items-center text-center">
            {/* Error icon */}
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-stratosort-danger/10">
              <svg
                className="h-6 w-6 text-stratosort-danger"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>

            <Heading as="h2" variant="h5" className="mb-2" id="search-error-title">
              Search encountered an error
            </Heading>

            <Text variant="small" className="mb-4 text-system-gray-600">
              Something went wrong while loading the search. You can try again or close the search
              modal.
            </Text>

            {/* Show error details in development */}
            {process.env.NODE_ENV === 'development' && error && (
              <div className="mb-4 w-full rounded-lg border border-border-soft bg-system-gray-100/90 p-3 text-left">
                <p className="break-all font-mono text-xs text-stratosort-danger">
                  {error.message || 'Unknown error'}
                </p>
              </div>
            )}

            <div className="flex gap-cozy">
              <Button variant="secondary" onClick={onClose} size="sm">
                Close
              </Button>
              <Button variant="primary" onClick={onRetry} size="sm">
                Try again
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

SearchErrorFallback.propTypes = {
  error: PropTypes.object,
  onRetry: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired
};

/**
 * Error boundary specifically for the search modal
 * FIX: Prevents unhandled exceptions from crashing the entire search functionality
 *
 * When an error occurs, displays a fallback UI with recovery options
 * instead of unmounting the entire search modal.
 */
class SearchErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render shows the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Log the error for debugging
    logger.error('[SearchErrorBoundary] Caught error in search modal', {
      error: error?.message,
      stack: error?.stack,
      componentStack: errorInfo?.componentStack
    });

    // Optionally report to error tracking service
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  handleClose = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onClose) {
      this.props.onClose();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <SearchErrorFallback
          error={this.state.error}
          onRetry={this.handleRetry}
          onClose={this.handleClose}
        />
      );
    }

    return this.props.children;
  }
}

SearchErrorBoundary.propTypes = {
  children: PropTypes.node.isRequired,
  onClose: PropTypes.func,
  onError: PropTypes.func
};

SearchErrorBoundary.defaultProps = {
  onClose: null,
  onError: null
};

export default SearchErrorBoundary;
