import { AGENTS, HOSTED, RECIPES, SELF_HOST, type InstallOption } from '../install';
import { CopyBlock } from '../components/CopyBlock';
import { ExternalLink } from '../components/ExternalLink';

const STATUS_LABEL: Record<InstallOption['status'], string> = {
  one_command: 'One step',
  guided: 'A few steps',
  not_packaged: 'Not available yet',
};

function OptionCard({ option }: { option: InstallOption }) {
  return (
    <li className="install-card" data-install={option.id} data-status={option.status}>
      <div className="install-card-head">
        <h3>{option.name}</h3>
        <span className={`status-chip install-${option.status}`}>{STATUS_LABEL[option.status]}</span>
      </div>
      <p>{option.outcome}</p>
      {option.command ? <CopyBlock text={option.command} label={`${option.name} setup`} /> : null}
      {option.steps?.length ? (
        <ul className="install-steps">
          {option.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      ) : null}
      <p className="install-source">
        <ExternalLink href={option.source}>Documentation</ExternalLink>
      </p>
    </li>
  );
}

export function Install() {
  const brief = RECIPES[0];
  return (
    <div className="page page-install">
      <p className="eyebrow">Install</p>
      <h1>How do you want to use Gavel?</h1>
      <p className="page-intro">
        Pick the place you already work. Browsing governance here needs nothing installed.
      </p>

      <nav className="install-paths" aria-label="Ways to use Gavel">
        <a href="#agent">With an agent you already use</a>
        <a href="#hosted">Hosted</a>
        <a href="#self-host">Self-host</a>
      </nav>

      <section id="agent" className="install-section" aria-labelledby="agent-heading">
        <h2 id="agent-heading">With an agent you already use</h2>
        <ul className="install-grid" aria-label="Agents">
          {AGENTS.map((option) => (
            <OptionCard key={option.id} option={option} />
          ))}
        </ul>
      </section>

      <section className="install-section recipe" aria-labelledby="recipe-heading">
        <p className="eyebrow">First thing to ask</p>
        <h2 id="recipe-heading">{brief.title}</h2>
        <p className="section-note">{brief.pitch}</p>
        <CopyBlock text={brief.prompt} label={`${brief.title} prompt`} />
      </section>

      <section id="hosted" className="install-section" aria-labelledby="hosted-heading">
        <h2 id="hosted-heading">Hosted</h2>
        <ul className="install-grid">
          <OptionCard option={HOSTED} />
        </ul>
      </section>

      <section id="self-host" className="install-section" aria-labelledby="self-heading">
        <h2 id="self-heading">Self-host</h2>
        <p className="section-note">For developers and operators. Same engine, your machine.</p>
        <ul className="install-grid">
          {SELF_HOST.map((option) => (
            <OptionCard key={option.id} option={option} />
          ))}
        </ul>
      </section>
    </div>
  );
}
