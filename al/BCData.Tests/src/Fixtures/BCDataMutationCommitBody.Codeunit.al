codeunit 50225 "BCD Mutation Commit Body"
{
    TableNo = "BCD Mutation Fixture";
    trigger OnRun()
    var
        Entry: Record "BCD Mutation Trigger Log";
    begin
        Entry."Event ID" := CreateGuid();
        Entry."Run ID" := Rec."Run ID";
        Entry.Action := 'C';
        Entry.Insert();
    end;
}
