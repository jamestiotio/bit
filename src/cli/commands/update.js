/** @flow */
import Command from '../command';

export default class Update extends Command {
  name = 'update [name]';
  description = 'update bit(s)';
  alias = 'u';
  opts = [];
  
  action(): Promise<any> {
    const m = this.alias;
    console.log('updating bits...');
    return new Promise(resolve => resolve(m));
  }

  report(data: {string: any}): string {
    return '';
  }
}
