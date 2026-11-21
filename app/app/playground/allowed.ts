// The playground is for admins, and for every member while developing (next dev).
export const playgroundAllowed = (isAdmin: boolean) => isAdmin || process.env.NODE_ENV === "development";
