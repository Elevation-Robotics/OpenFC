import type { Metadata } from 'next';
import DocsLayout, {
  Code,
  Note,
  Section,
  T,
  Table,
} from '@/components/docs/DocsLayout';
import {
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR,
  ORG_NAME,
  REPO_URL,
} from '@/lib/site';

// Licensing terms. Software and hardware are covered by different licences —
// Apache-2.0 is written for source code and maps poorly onto a PCB — so both
// are stated explicitly rather than left to a single blanket claim.

export const metadata: Metadata = {
  title: 'License — OpenFC',
  description:
    'OpenFC is open source: software under Apache-2.0, hardware under CERN-OHL-P-2.0. Free to use, modify, manufacture and sell.',
};

export default function LicenseDocs() {
  return (
    <DocsLayout
      title="License"
      active="/docs/license"
      intro={
        <>
          Everything is open source and free to use commercially — build them,
          sell them, modify them, no permission needed. Software and hardware
          carry different licences because they are different kinds of work.
        </>
      }
    >
      <Section id="summary" title="What applies to what">
        <Table
          head={['Part of the project', 'License']}
          rows={[
            [
              'Firmware, web application, documentation',
              <T key="a">Apache-2.0</T>,
            ],
            [
              'Hardware design — schematic, PCB layout, gerbers, BOM',
              <T key="c">CERN-OHL-P-2.0</T>,
            ],
          ]}
        />
        <p>
          Apache-2.0 is written in terms of source code and object code, which
          does not describe a circuit board well. CERN-OHL-P is its hardware
          equivalent from CERN: the same permissive intent, but with wording
          that covers schematics, layouts and manufactured boards. Both are
          OSI/OSHWA-recognised and compatible with each other.
        </p>
      </Section>

      <Section id="rights" title="What you can do">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Use it for anything</strong>, including commercially. No fee
            and no permission required.
          </li>
          <li>
            <strong>Manufacture and sell boards.</strong> Build one for your
            team or a hundred to sell — both are fine.
          </li>
          <li>
            <strong>Modify anything</strong> and keep your changes private. You
            are not obliged to publish them.
          </li>
          <li>
            <strong>Redistribute</strong> under these terms or as part of a
            larger work under different terms.
          </li>
        </ul>
        <p>Two conditions, and they are the usual ones:</p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            Keep the copyright notice, the licence text and the{' '}
            <T>NOTICE</T> file with any copy you distribute.
          </li>
          <li>
            State significant changes you made, so users can tell a modified
            version from the original.
          </li>
        </ul>
        <p>
          Apache-2.0 also grants an explicit patent licence, so contributors
          cannot later assert patents over what they contributed. That is the
          main reason to prefer it over MIT for a hardware-adjacent project.
        </p>
      </Section>

      <Section id="firmware" title="Modified firmware and competition legality">
        <p>
          You are free to modify the firmware. Doing so does not make your board
          unusable — but it does change what the verification API reports.
        </p>
        <Note kind="warn">
          A board running a modified build reports an <T>fw_hash</T> that is not
          in the published hash table, so it verifies as{' '}
          <strong>unrecognised</strong> rather than certified. That is a factual
          statement about which bytes are running, not a judgement about your
          code. If you want a modified build treated as official, it has to be
          published as a release here.
        </Note>
        <p>
          The certification claim is only meaningful because it is a hash of the
          actual running code. A modified firmware that still reported as
          certified would make the whole mechanism worthless.
        </p>
      </Section>

      <Section id="warranty" title="No warranty">
        <p>
          Both licences disclaim all warranties and liability. This is a device
          that enables and disables robots, so it is worth stating plainly:
        </p>
        <Note kind="warn">
          OpenFC is provided <strong>as is</strong>. You are responsible for
          verifying it behaves correctly in your setup before relying on it, and
          for the safety of anyone near the field.
        </Note>
      </Section>

      <Section id="trademarks" title="Trademarks">
        <p>
          Neither licence grants trademark rights. VEX, VEX Robotics and V5 are
          trademarks of Innovation First, Inc. OpenFC is an independent project
          of Elevation Robotics and is not affiliated with, manufactured,
          endorsed, approved or sponsored by Innovation First, Inc., VEX
          Robotics or the REC Foundation. Those names appear here only to
          describe what the board is compatible with.
        </p>
        <p>
          If you sell boards based on this design, do not imply VEX or RECF
          endorsement.
        </p>
      </Section>

      <Section id="attribution" title="Attributing OpenFC">
        <p>
          If you distribute this project or something derived from it, include a
          notice along these lines:
        </p>
        <Code label="NOTICE">{`OpenFC — a project of ${ORG_NAME}
Copyright ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}
Licensed under the Apache License, Version 2.0.
Hardware design licensed under CERN-OHL-P-2.0.
${REPO_URL}`}</Code>
      </Section>

      <Section id="full" title="Full texts">
        <p>
          The complete licences are in the repository as <T>LICENSE</T>{' '}
          (Apache-2.0), <T>LICENSE-hardware</T> (CERN-OHL-P-2.0) and{' '}
          <T>NOTICE</T>.
        </p>
        <p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            {REPO_URL.replace('https://', '')}
          </a>
        </p>
      </Section>
    </DocsLayout>
  );
}
