// lib/relativeTime.js
// "2 hours ago" reads better than a timestamp on something that just
// happened. Shared between the customer Alerts tab (routes/customer-
// account.js) and the merchant Notifications tab (routes/account-
// business.js) so the two can't drift apart on how "recent" is worded.
function relativeTime(date) {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  return date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

module.exports = { relativeTime };
