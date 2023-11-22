import { MigrateOptions } from '../../fireway';

export async function migrate({firestore} : MigrateOptions) {
    firestore.collection('data').doc('one').get();
};
