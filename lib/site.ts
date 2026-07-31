// Site-wide constants that appear in more than one place.
//
// These were previously duplicated across the landing page, the docs pages and
// the API generator, which let them drift out of step with where the code
// actually lives.

/** Canonical source repository. */
export const REPO_URL = 'https://github.com/Elevation-Robotics/OpenFC';

/**
 * Canonical origin for absolute links the site publishes about itself.
 *
 * The site answers on several hostnames (openfc.dev and
 * openfc.elevationrobotics.org). They serve identical content, so anything
 * published outward — API download URLs, canonical tags — must name one host,
 * or a board verified via one domain would reference downloads on the other.
 */
export const SITE_URL = process.env.OPENFC_BASE_URL ?? 'https://openfc.dev';

/** The organisation behind the project. */
export const ORG_NAME = 'Elevation Robotics';
export const ORG_URL = 'https://elevationrobotics.org';
export const ORG_LOGO = '/elevation-robotics-horizontal-dark.svg';

export const LICENSE_SOFTWARE = 'Apache-2.0';
export const LICENSE_HARDWARE = 'CERN-OHL-P-2.0';
export const COPYRIGHT_HOLDER = 'Mack Kemper';
export const COPYRIGHT_YEAR = '2026';
