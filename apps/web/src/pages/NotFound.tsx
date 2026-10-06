import { Link } from 'react-router-dom';
import { paths } from '../routes';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="page">
      <p className="eyebrow">Gavel</p>
      <h1>Not found</h1>
      <p className="page-intro">
        No {what} matches this address. Try <Link to={paths.daos}>DAOs</Link>, the{' '}
        <Link to={paths.gate}>Gate directory</Link>, or <Link to={paths.home}>home</Link>.
      </p>
    </div>
  );
}
