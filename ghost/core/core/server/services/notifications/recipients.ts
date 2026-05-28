// Resolves audiences for notification delivery. The mailer takes a `to=` list;
// this module decides what's in that list. Today only "admins" exists; future
// work can add severity-driven audiences (e.g. a configured manager address
// with admin fallback for critical alerts) without changing the mailer.

interface UserCollection {
    toJSON(): Array<{email?: string; roles?: Array<{name: string}>}>;
}

interface UserModel {
    findAll(options: {filter?: string; withRelated?: string[]}): Promise<UserCollection>;
}

const ADMIN_ROLES: ReadonlyArray<string> = ['Owner', 'Administrator'];

export async function getAdminEmails(User: UserModel): Promise<string[]> {
    const users = await User.findAll({filter: 'status:active', withRelated: ['roles']});
    return users.toJSON()
        .filter(user => user?.roles?.some(role => ADMIN_ROLES.includes(role.name)))
        .map(user => user.email)
        .filter((email): email is string => Boolean(email));
}
